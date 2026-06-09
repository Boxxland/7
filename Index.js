const {
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder,
    REST, Routes, PermissionFlagsBits, ChannelType,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');
const fs = require('fs');
const https = require('https');
const http = require('http');
const QRCode = require('qrcode');
const Jimp = require('jimp');
const jsQR = require('jsqr');

const crypto = require('crypto');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 นาที

// Map: userId → lastActiveTimestamp
const activeSessions = new Map();

// pendingJobOffers: offerId → { ownerId, targetId, role, shopName, sentAt }
const pendingJobOffers = new Map();

function hashPassword(pw) {
    return crypto.createHash('sha256').update(pw + 'econ_salt_2025').digest('hex');
}

function isSessionActive(userId) {
    const ud = getUser(userId);
    // ถ้าผู้ใช้ปิด session timeout → ถือว่า active ตลอดถ้ามีบัญชี
    if (ud.noSessionTimeout && ud.loggedIn) return true;
    if (!activeSessions.has(userId)) return false;
    const lastActive = activeSessions.get(userId);
    if (Date.now() - lastActive > SESSION_TIMEOUT) {
        activeSessions.delete(userId);
        return false;
    }
    return true;
}

function touchSession(userId) {
    if (activeSessions.has(userId)) {
        activeSessions.set(userId, Date.now());
    }
}

// ล้าง session ที่หมดอายุทุก 1 นาที
setInterval(() => {
    const now = Date.now();
    for (const [uid, lastActive] of activeSessions.entries()) {
        if (now - lastActive > SESSION_TIMEOUT) activeSessions.delete(uid);
    }
}, 60_000);

const DATA_FILE    = './data.json';
const CONFIG_FILE  = './config.json';
const STOCKS_FILE  = './stocks.json';
const LOTTERY_FILE = './lottery.json';

// ─── Data helpers ─────────────────────────────────────────────────────────────

function loadData() {
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');
    return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, '{}');
    return JSON.parse(fs.readFileSync(CONFIG_FILE));
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

function loadLottery() {
    if (!fs.existsSync(LOTTERY_FILE)) {
        const init = { pool: 0, tickets: [], lastDraw: null, lastResult: null };
        fs.writeFileSync(LOTTERY_FILE, JSON.stringify(init, null, 2));
    }
    return JSON.parse(fs.readFileSync(LOTTERY_FILE));
}
function saveLottery(l) { fs.writeFileSync(LOTTERY_FILE, JSON.stringify(l, null, 2)); }

function msTillMidnightBKK() {
    const now = Date.now();
    const bkk = new Date(now + 7 * 3600_000);
    const midnight = Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate() + 1) - 7 * 3600_000;
    return midnight - now;
}

async function runLotteryDraw() {
    const lottery = loadLottery();
    if (!lottery.tickets.length) {
        lottery.lastResult = { drawn: null, winners: [], prize: 0, note: 'ไม่มีผู้ซื้อสลากวันนี้' };
        lottery.lastDraw = Date.now();
        lottery.tickets = [];
        saveLottery(lottery);
        scheduleLotteryDraw();
        return;
    }
    const drawnNumber = Math.floor(Math.random() * 99) + 1;
    const winners = lottery.tickets.filter(t => t.number === drawnNumber);
    const prizePool = Math.floor(lottery.pool * 0.7);

    if (winners.length) {
        const share = Math.floor(prizePool / winners.length);
        for (const w of winners) {
            const ud = getUser(w.userId);
            updateUser(w.userId, { balance: ud.balance + share });
            addInbox(w.userId, '🎰', `ถูกรางวัลลอตเตอรี่! เลข **${drawnNumber}** ได้รับ **${share.toLocaleString()} บาท**`);
        }
        lottery.lastResult = { drawn: drawnNumber, winners: winners.map(w => ({ userId: w.userId, charName: w.charName })), prize: share };
        lottery.pool = 0;
    } else {
        lottery.lastResult = { drawn: drawnNumber, winners: [], prize: 0, note: 'ไม่มีผู้ถูกรางวัล — พูลสะสมต่อไป' };
    }
    lottery.lastDraw = Date.now();
    lottery.tickets = [];
    saveLottery(lottery);
    scheduleLotteryDraw();
}

function scheduleLotteryDraw() {
    const ms = msTillMidnightBKK();
    setTimeout(runLotteryDraw, ms);
}

function loadStocks() {
    if (!fs.existsSync(STOCKS_FILE)) {
        const init = {
            SKBD:  { symbol: 'SKBD',  name: 'Skybot Corp',    emoji: '🤖', sector: 'เทคโนโลยี',  price: 120, prevPrice: 120, change: 0, history: [120], volume: 0 },
            BREAD: { symbol: 'BREAD', name: 'Breadfarm Ltd',  emoji: '🍞', sector: 'อาหาร',      price: 45,  prevPrice: 45,  change: 0, history: [45],  volume: 0 },
            GOLD:  { symbol: 'GOLD',  name: 'Gold Standard',  emoji: '🥇', sector: 'สินค้าโภค', price: 300, prevPrice: 300, change: 0, history: [300], volume: 0 },
            DBANK: { symbol: 'DBANK', name: 'Discord Bank',   emoji: '🏦', sector: 'การเงิน',    price: 200, prevPrice: 200, change: 0, history: [200], volume: 0 },
            FARM:  { symbol: 'FARM',  name: 'FarmCo Inc',     emoji: '🌾', sector: 'เกษตร',      price: 80,  prevPrice: 80,  change: 0, history: [80],  volume: 0 },
            TECH:  { symbol: 'TECH',  name: 'TechWave',       emoji: '💻', sector: 'เทคโนโลยี',  price: 500, prevPrice: 500, change: 0, history: [500], volume: 0 },
        };
        fs.writeFileSync(STOCKS_FILE, JSON.stringify(init, null, 2));
    }
    return JSON.parse(fs.readFileSync(STOCKS_FILE));
}
function saveStocks(s) { fs.writeFileSync(STOCKS_FILE, JSON.stringify(s, null, 2)); }

function getUser(userId) {
    const d = loadData();
    if (!d[userId]) { d[userId] = { balance: 0, deposited: 0, loggedIn: false, shop: null, shopOpen: false, home: null, lastWork: null, shopStaff: [], shopMenu: [] }; saveData(d); }
    return d[userId];
}
function updateUser(userId, updates) {
    const d = loadData(); d[userId] = { ...d[userId], ...updates }; saveData(d);
}

// หา userId จากชื่อบัญชี (case-insensitive)
function findUserIdByCharName(charName) {
    const d = loadData();
    const lower = charName.toLowerCase();
    for (const [uid, ud] of Object.entries(d)) {
        if (ud.charName && ud.charName.toLowerCase() === lower) return uid;
    }
    return null;
}

// ตั้ง nickname ในเซิร์ฟเวอร์ (ข้ามถ้าไม่มีสิทธิ์หรือไม่อยู่ใน guild)
async function trySetNickname(interaction, charName) {
    try {
        if (interaction.member && interaction.guild) {
            await interaction.member.setNickname(charName);
        }
    } catch { /* บอทไม่มีสิทธิ์ หรือเป็น server owner — ข้ามได้ */ }
}

// เพิ่มข้อความในกล่องขาเข้าของผู้ใช้ (สูงสุด 30 ข้อความ)
function addInbox(userId, icon, text) {
    const d = loadData();
    if (!d[userId]) return;
    if (!d[userId].inbox) d[userId].inbox = [];
    d[userId].inbox.unshift({ icon, text, time: Date.now() });
    if (d[userId].inbox.length > 30) d[userId].inbox = d[userId].inbox.slice(0, 30);
    saveData(d);
}

// ตรวจสอบ PIN ในธุรกรรม — คืน false แล้ว reply ถ้าไม่ผ่าน
function checkPIN(interaction, ud) {
    if (!ud.pinHash) return true;
    let pinRaw = '';
    try { pinRaw = interaction.fields.getTextInputValue('pin_verify').trim(); } catch { return true; }
    if (hashPassword(pinRaw) !== ud.pinHash) {
        interaction.reply({ content: '❌ PIN ไม่ถูกต้อง! ธุรกรรมถูกยกเลิก', ephemeral: true });
        return false;
    }
    return true;
}

// เพิ่ม field PIN ในกรณีที่ user ตั้ง PIN ไว้
function addPinFieldIfNeeded(modal, ud) {
    if (ud.pinHash) {
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('pin_verify').setLabel('🔢 ยืนยัน PIN').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(6).setPlaceholder('กรอก PIN เพื่อยืนยันธุรกรรม')
        ));
    }
}

function requireLogin(interaction) {
    const uid = interaction.user.id;
    const u = getUser(uid);
    if (!u.loggedIn || !isSessionActive(uid)) {
        interaction.reply({
            embeds: [new EmbedBuilder().setColor(0xff0000).setTitle('❌ ยังไม่ได้เข้าสู่ระบบ')
                .setDescription(u.loggedIn ? '⏰ Session หมดอายุเพราะไม่ได้ใช้งาน 5 นาที\nกรุณากด `/panel` → **🔐 เข้าสู่ระบบ** อีกครั้ง' : 'กรุณาใช้ `/panel` → **📝 สมัครสมาชิก** ก่อนใช้งาน')],
            ephemeral: true,
        });
        return false;
    }
    touchSession(uid);
    return true;
}

function sanitizeChannelName(n) { return n.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9ก-๙\-]/g, '').slice(0, 90) || 'channel'; }

async function getOrCreateCategory(guild, name) {
    let c = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === name);
    if (!c) c = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    return c;
}

function downloadImage(url) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        proto.get(url, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject); }).on('error', reject);
    });
}

function updateStockPrices() {
    const s = loadStocks();
    for (const sym of Object.keys(s)) {
        const drift = (Math.random() - 0.48) * 0.08;
        const np = Math.max(1, Math.round(s[sym].price * (1 + drift)));
        s[sym].change = parseFloat((((np - s[sym].price) / s[sym].price) * 100).toFixed(2));
        s[sym].prevPrice = s[sym].price; s[sym].price = np;
        s[sym].history = [...s[sym].history.slice(-4), np]; s[sym].volume = 0;
    }
    saveStocks(s);
}

// ─── อาชีพ ─────────────────────────────────────────────────────────────────────

const JOBS = {
    chef:       { emoji: '🍳', name: 'พ่อครัว',        min: 80,  max: 250, desc: 'ปรุงอาหารและพัฒนาสูตรใหม่',      start: 120 },
    builder:    { emoji: '🔨', name: 'ช่างก่อสร้าง',   min: 50,  max: 200, desc: 'สร้างบ้านและอาคาร',               start: 100 },
    driver:     { emoji: '🚗', name: 'คนขับรถ',         min: 60,  max: 180, desc: 'ขับรถรับส่งผู้โดยสาร',            start: 100 },
    programmer: { emoji: '💻', name: 'โปรแกรมเมอร์',   min: 150, max: 500, desc: 'เขียนโค้ดและพัฒนาระบบ',          start: 80  },
    delivery:   { emoji: '📦', name: 'คนส่งของ',        min: 50,  max: 150, desc: 'ส่งพัสดุตามที่อยู่',              start: 110 },
    farmer:     { emoji: '🌾', name: 'เกษตรกร',         min: 70,  max: 220, desc: 'เพาะปลูกและเก็บเกี่ยว',          start: 130 },
    trader:     { emoji: '🧾', name: 'พ่อค้า',          min: 90,  max: 300, desc: 'ซื้อขายสินค้าในตลาด',            start: 90  },
    doctor:     { emoji: '🩺', name: 'หมอ',             min: 200, max: 600, desc: 'รักษาผู้ป่วยและให้คำปรึกษา',     start: 60  },
};

// ─── Slash Commands ────────────────────────────────────────────────────────────

const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('เปิด Panel ควบคุมระบบทั้งหมด'),

    // Legacy slash commands (ยังใช้ได้)
    new SlashCommandBuilder().setName('login').setDescription('สร้างตัวละครและเข้าสู่ระบบ')
        .addStringOption(o => o.setName('charname').setDescription('ชื่อตัวละคร').setRequired(true).setMaxLength(30))
        .addStringOption(o => o.setName('job').setDescription('อาชีพตั้งต้น').setRequired(true)
            .addChoices(...Object.entries(JOBS).map(([k, j]) => ({ name: `${j.emoji} ${j.name} (${j.min}-${j.max} บาท)`, value: k })))),

    new SlashCommandBuilder().setName('balance').setDescription('ดูยอดเงิน'),
    new SlashCommandBuilder().setName('work').setDescription('ทำงาน (คูลดาวน์ 30 นาที)'),

    new SlashCommandBuilder().setName('give').setDescription('โอนเงินให้ผู้อื่น')
        .addUserOption(o => o.setName('user').setDescription('ผู้รับ').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder().setName('deploysit').setDescription('ฝากเงินธนาคาร')
        .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder().setName('withdraw').setDescription('ถอนเงินธนาคาร')
        .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder().setName('qrscan').setDescription('สร้าง QR Code รับเงิน'),

    new SlashCommandBuilder().setName('scanqr').setDescription('สแกน QR โอนเงิน')
        .addAttachmentOption(o => o.setName('qr').setDescription('รูป QR').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder().setName('newshop').setDescription('เปิดร้านค้า (500 บาท)')
        .addStringOption(o => o.setName('name').setDescription('ชื่อร้าน').setRequired(true)),

    new SlashCommandBuilder().setName('openshop').setDescription('เปิดร้าน'),
    new SlashCommandBuilder().setName('closeshop').setDescription('ปิดร้าน'),

    new SlashCommandBuilder().setName('addmenu').setDescription('เพิ่มสินค้า')
        .addStringOption(o => o.setName('name').setDescription('ชื่อ').setRequired(true).setMaxLength(50))
        .addIntegerOption(o => o.setName('price').setDescription('ราคา').setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName('description').setDescription('รายละเอียด').setRequired(false))
        .addIntegerOption(o => o.setName('stock').setDescription('สต็อก (ไม่ระบุ=ไม่จำกัด)').setRequired(false).setMinValue(1)),

    new SlashCommandBuilder().setName('removemenu').setDescription('ลบสินค้า')
        .addStringOption(o => o.setName('name').setDescription('ชื่อสินค้า').setRequired(true)),

    new SlashCommandBuilder().setName('menu').setDescription('ดูเมนูร้านค้า')
        .addUserOption(o => o.setName('user').setDescription('เจ้าของร้าน').setRequired(true)),

    new SlashCommandBuilder().setName('order').setDescription('สั่งซื้อสินค้า')
        .addUserOption(o => o.setName('user').setDescription('เจ้าของร้าน').setRequired(true))
        .addStringOption(o => o.setName('item').setDescription('ชื่อสินค้า').setRequired(true))
        .addIntegerOption(o => o.setName('quantity').setDescription('จำนวน').setRequired(false).setMinValue(1)),

    new SlashCommandBuilder().setName('restock').setDescription('เติมสต็อก')
        .addStringOption(o => o.setName('name').setDescription('ชื่อสินค้า').setRequired(true))
        .addIntegerOption(o => o.setName('quantity').setDescription('จำนวน').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder().setName('inventory').setDescription('ดูสต็อกสินค้า')
        .addUserOption(o => o.setName('user').setDescription('เจ้าของร้าน').setRequired(false)),

    new SlashCommandBuilder().setName('hire').setDescription('รับพนักงาน')
        .addUserOption(o => o.setName('user').setDescription('ผู้ใช้').setRequired(true))
        .addStringOption(o => o.setName('role').setDescription('ตำแหน่ง').setRequired(false)),

    new SlashCommandBuilder().setName('fire').setDescription('ไล่พนักงานออก')
        .addUserOption(o => o.setName('user').setDescription('พนักงาน').setRequired(true)),

    new SlashCommandBuilder().setName('staff').setDescription('ดูรายชื่อพนักงาน'),

    new SlashCommandBuilder().setName('newhome').setDescription('ซื้อบ้าน (1,000 บาท)')
        .addStringOption(o => o.setName('name').setDescription('ชื่อบ้าน').setRequired(true)),

    new SlashCommandBuilder().setName('invite').setDescription('เชิญเพื่อนเข้าบ้าน')
        .addUserOption(o => o.setName('user').setDescription('เพื่อน').setRequired(true)),

    new SlashCommandBuilder().setName('uninvite').setDescription('เตะเพื่อนออกจากบ้าน')
        .addUserOption(o => o.setName('user').setDescription('เพื่อน').setRequired(true)),

    new SlashCommandBuilder().setName('profile').setDescription('ดูโปรไฟล์')
        .addUserOption(o => o.setName('user').setDescription('ผู้ใช้').setRequired(false)),

    new SlashCommandBuilder().setName('shoplist').setDescription('ดูร้านค้าทั้งหมด'),
    new SlashCommandBuilder().setName('job').setDescription('ดูรายการอาชีพ'),
    new SlashCommandBuilder().setName('help').setDescription('ดูคำสั่งทั้งหมด'),

    new SlashCommandBuilder().setName('lottery').setDescription('ดูข้อมูลลอตเตอรี่รายวัน'),

    new SlashCommandBuilder().setName('setdeposit').setDescription('[แอดมิน] ตั้งช่องแจ้งเตือนฝากเงิน')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(o => o.setName('channel').setDescription('ช่อง').setRequired(true)),

    new SlashCommandBuilder().setName('stock').setDescription('ตลาดหุ้น')
        .addSubcommand(s => s.setName('list').setDescription('ดูรายการหุ้น'))
        .addSubcommand(s => s.setName('buy').setDescription('ซื้อหุ้น')
            .addStringOption(o => o.setName('symbol').setDescription('ชื่อย่อ').setRequired(true).addChoices({ name: 'SKBD', value: 'SKBD' }, { name: 'BREAD', value: 'BREAD' }, { name: 'GOLD', value: 'GOLD' }, { name: 'DBANK', value: 'DBANK' }, { name: 'FARM', value: 'FARM' }, { name: 'TECH', value: 'TECH' }))
            .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s.setName('sell').setDescription('ขายหุ้น')
            .addStringOption(o => o.setName('symbol').setDescription('ชื่อย่อ').setRequired(true).addChoices({ name: 'SKBD', value: 'SKBD' }, { name: 'BREAD', value: 'BREAD' }, { name: 'GOLD', value: 'GOLD' }, { name: 'DBANK', value: 'DBANK' }, { name: 'FARM', value: 'FARM' }, { name: 'TECH', value: 'TECH' }))
            .addIntegerOption(o => o.setName('amount').setDescription('จำนวน').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s.setName('portfolio').setDescription('ดูพอร์ต')),
];

// ─── Register ──────────────────────────────────────────────────────────────────

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
        console.log('✅ Slash commands registered');
    } catch (e) { console.error('Register error:', e); }
}

client.once('ready', async () => {
    console.log(`✅ Online: ${client.user.tag}`);
    await registerCommands();
    setInterval(updateStockPrices, 5 * 60 * 1000);
    scheduleLotteryDraw();
    console.log(`🎰 ลอตเตอรี่ครั้งถัดไป: อีก ${Math.round(msTillMidnightBKK() / 60_000)} นาที`);
});

// ════════════════════════════════════════════════════════════════════════════════
// PANEL BUILDERS
// ════════════════════════════════════════════════════════════════════════════════

function buildMainPanel(userId) {
    const ud = getUser(userId);
    const job = ud.jobKey ? JOBS[ud.jobKey] : null;

    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎮 PANEL — ศูนย์ควบคุม')
        .setDescription(ud.loggedIn
            ? `ยินดีต้อนรับ **${ud.charName}** ${job ? `${job.emoji} ${job.name}` : ''}\n💵 \`${ud.balance.toLocaleString()}\` บาท | 🏦 \`${ud.deposited.toLocaleString()}\` บาท`
            : '⚠️ ยังไม่ได้สร้างตัวละคร กด **👤 ตัวละคร** เพื่อเริ่มต้น')
        .addFields(
            { name: '👤 ตัวละคร', value: 'โปรไฟล์, Login', inline: true },
            { name: '💰 การเงิน', value: 'งาน, ฝาก, ถอน, โอน', inline: true },
            { name: '🏪 ร้านค้า', value: 'เปิด/ปิดร้าน, สร้างร้าน', inline: true },
            { name: '📋 เมนู', value: 'เพิ่ม/ลบสินค้า, ดูเมนู', inline: true },
            { name: '📦 สต็อก', value: 'Inventory, เติมสต็อก', inline: true },
            { name: '👥 พนักงาน', value: 'จ้าง, ไล่ออก, ดูรายชื่อ', inline: true },
            { name: '🏠 บ้าน', value: 'ซื้อบ้าน, เชิญ, เตะ', inline: true },
            { name: '📊 หุ้น', value: 'ซื้อ/ขายหุ้น, พอร์ต', inline: true },
            { name: '📲 QR', value: 'สร้าง/สแกน QR', inline: true },
            { name: '🎰 ลอตเตอรี่', value: 'ซื้อสลาก, ดูผล', inline: true },
            { name: '⚙️ ตั้งค่า', value: 'PIN, Bio, สี Embed, Session', inline: true },
        )
        .setFooter({ text: 'กดปุ่มด้านล่างเพื่อเข้าระบบที่ต้องการ' })
        .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_character').setLabel('👤 ตัวละคร').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('panel_finance').setLabel('💰 การเงิน').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('panel_shop').setLabel('🏪 ร้านค้า').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('panel_menu').setLabel('📋 เมนู').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_stock_inv').setLabel('📦 สต็อก').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_staff').setLabel('👥 พนักงาน').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('panel_home').setLabel('🏠 บ้าน').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('panel_stock').setLabel('📊 หุ้น').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('panel_qr').setLabel('📲 QR').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_refresh').setLabel('🔄 รีเฟรช').setStyle(ButtonStyle.Secondary),
    );
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('panel_lottery').setLabel('🎰 ลอตเตอรี่รายวัน').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('panel_settings').setLabel('⚙️ ตั้งค่า').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_inbox').setLabel('📬 กล่องขาเข้า').setStyle(ButtonStyle.Primary),
    );

    return { embeds: [embed], components: [row1, row2, row3], ephemeral: true };
}

function buildCharacterPanel(userId) {
    const ud = getUser(userId);
    const job = ud.jobKey ? JOBS[ud.jobKey] : null;
    const hasAccount = ud.loggedIn; // มีบัญชีในระบบแล้ว
    const hasSession = isSessionActive(userId); // session ใช้งานอยู่

    let statusText;
    if (!hasAccount) {
        statusText = '❌ ยังไม่มีบัญชี — กด **📝 สมัครสมาชิก** เพื่อสร้างตัวละคร';
    } else if (!hasSession) {
        statusText = `🔒 มีบัญชีแล้วในชื่อ **${ud.charName}** — กด **🔐 เข้าสู่ระบบ** และกรอกรหัสผ่าน`;
    } else {
        statusText = `✅ เข้าสู่ระบบอยู่\n🪪 **${ud.charName}** | ${job ? `${job.emoji} ${job.name}` : '-'}\n💵 ${ud.balance.toLocaleString()} บาท`;
    }

    const embed = new EmbedBuilder()
        .setColor(hasSession ? 0x00cc66 : hasAccount ? 0xffcc00 : 0xed4245)
        .setTitle('👤 Panel — ตัวละคร & โปรไฟล์')
        .setDescription(statusText)
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_register').setLabel('📝 สมัครสมาชิก').setStyle(ButtonStyle.Success).setDisabled(hasAccount),
        new ButtonBuilder().setCustomId('action_login').setLabel('🔐 เข้าสู่ระบบ').setStyle(ButtonStyle.Primary).setDisabled(!hasAccount || hasSession),
        new ButtonBuilder().setCustomId('action_profile').setLabel('👤 ดูโปรไฟล์').setStyle(ButtonStyle.Secondary).setDisabled(!hasSession),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildFinancePanel(userId) {
    const ud = getUser(userId);
    let workCooldown = '✅ พร้อมทำงาน';
    if (ud.lastWork) { const r = 30 * 60 * 1000 - (Date.now() - ud.lastWork); if (r > 0) workCooldown = `⏳ อีก ${Math.ceil(r / 60000)} นาที`; }
    const job = ud.jobKey ? JOBS[ud.jobKey] : null;

    const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('💰 Panel — การเงิน')
        .addFields(
            { name: '💵 กระเป๋า', value: `${ud.balance.toLocaleString()} บาท`, inline: true },
            { name: '🏦 ธนาคาร', value: `${ud.deposited.toLocaleString()} บาท`, inline: true },
            { name: '💎 รวม', value: `${(ud.balance + ud.deposited).toLocaleString()} บาท`, inline: true },
            { name: `${job ? job.emoji : '💼'} งาน`, value: workCooldown, inline: true },
        )
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_work').setLabel('💼 ทำงาน').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('action_deposit').setLabel('🏦 ฝากเงิน').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('action_withdraw').setLabel('💸 ถอนเงิน').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('action_give').setLabel('🤝 โอนเงิน').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildShopPanel(userId) {
    const ud = getUser(userId);
    const hasShop = !!ud.shop;
    const menuCount = (ud.shopMenu || []).length;
    const staffCount = (ud.shopStaff || []).length;

    const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle('🏪 Panel — ร้านค้า')
        .addFields(
            { name: '🏪 ชื่อร้าน', value: ud.shop || '❌ ยังไม่มีร้าน', inline: true },
            { name: '📊 สถานะ', value: hasShop ? (ud.shopOpen ? '🟢 เปิดอยู่' : '🔴 ปิดอยู่') : '-', inline: true },
            { name: '📋 สินค้า', value: hasShop ? `${menuCount} รายการ` : '-', inline: true },
            { name: '👥 พนักงาน', value: hasShop ? `${staffCount} คน` : '-', inline: true },
        )
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_newshop').setLabel('🏗️ สร้างร้าน').setStyle(ButtonStyle.Success).setDisabled(hasShop),
        new ButtonBuilder().setCustomId('action_openshop').setLabel('🟢 เปิดร้าน').setStyle(ButtonStyle.Success).setDisabled(!hasShop || !!ud.shopOpen),
        new ButtonBuilder().setCustomId('action_closeshop').setLabel('🔴 ปิดร้าน').setStyle(ButtonStyle.Danger).setDisabled(!hasShop || !ud.shopOpen),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildMenuPanel(userId) {
    const ud = getUser(userId);
    const menu = ud.shopMenu || [];
    const embed = new EmbedBuilder()
        .setColor(0xffa500)
        .setTitle('📋 Panel — เมนูสินค้า')
        .setDescription(ud.shop ? `ร้าน **${ud.shop}** — ${menu.length}/20 สินค้า` : '❌ ยังไม่มีร้านค้า');

    if (menu.length) {
        menu.slice(0, 10).forEach((item, i) => {
            const stock = item.stock == null ? '♾️' : item.stock > 0 ? `📦${item.stock}` : '❌หมด';
            embed.addFields({ name: `${i + 1}. ${item.name}`, value: `${item.price.toLocaleString()} บาท | ${stock}`, inline: true });
        });
    }
    embed.setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_addmenu').setLabel('➕ เพิ่มสินค้า').setStyle(ButtonStyle.Success).setDisabled(!ud.shop),
        new ButtonBuilder().setCustomId('action_removemenu').setLabel('🗑️ ลบสินค้า').setStyle(ButtonStyle.Danger).setDisabled(!ud.shop || !menu.length),
        new ButtonBuilder().setCustomId('action_viewmenu').setLabel('👁️ ดูเมนูทั้งหมด').setStyle(ButtonStyle.Primary).setDisabled(!ud.shop),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildInventoryPanel(userId) {
    const ud = getUser(userId);
    const menu = ud.shopMenu || [];
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📦 Panel — Inventory & สต็อก')
        .setDescription(ud.shop ? `ร้าน **${ud.shop}**` : '❌ ยังไม่มีร้านค้า')
        .setTimestamp();

    if (menu.length) {
        menu.forEach(item => {
            const stock = item.stock == null ? '♾️ ไม่จำกัด' : item.stock > 0 ? `✅ ${item.stock} ชิ้น` : '❌ หมด';
            const bar = item.stock == null ? '██████████' : item.stock === 0 ? '░░░░░░░░░░' : '█'.repeat(Math.min(10, Math.ceil(item.stock / 5))) + '░'.repeat(Math.max(0, 10 - Math.ceil(item.stock / 5)));
            embed.addFields({ name: `🛒 ${item.name}`, value: `${stock}\n\`${bar}\``, inline: true });
        });
    } else if (ud.shop) {
        embed.setDescription(`ร้าน **${ud.shop}** — ยังไม่มีสินค้า`);
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_restock').setLabel('📦 เติมสต็อก').setStyle(ButtonStyle.Success).setDisabled(!ud.shop || !menu.length),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildStaffPanel(userId) {
    const ud = getUser(userId);
    const staff = ud.shopStaff || [];

    const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('👥 Panel — พนักงาน')
        .setDescription(ud.shop ? `ร้าน **${ud.shop}** — ${staff.length} คน` : '❌ ยังไม่มีร้านค้า')
        .setTimestamp();

    if (staff.length) {
        staff.forEach((s, i) => {
            embed.addFields({ name: `${i + 1}. <@${s.id}>`, value: `👔 ${s.role}`, inline: true });
        });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_hire').setLabel('➕ รับพนักงาน').setStyle(ButtonStyle.Success).setDisabled(!ud.shop),
        new ButtonBuilder().setCustomId('action_fire').setLabel('❌ ไล่ออก').setStyle(ButtonStyle.Danger).setDisabled(!ud.shop || !staff.length),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildHomePanel(userId) {
    const ud = getUser(userId);

    const embed = new EmbedBuilder()
        .setColor(0x9933ff)
        .setTitle('🏠 Panel — บ้าน')
        .addFields({ name: '🏠 บ้าน', value: ud.home || '❌ ยังไม่มีบ้าน', inline: true })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_newhome').setLabel('🏗️ ซื้อบ้าน').setStyle(ButtonStyle.Success).setDisabled(!!ud.home),
        new ButtonBuilder().setCustomId('action_invite').setLabel('🤝 เชิญเพื่อน').setStyle(ButtonStyle.Primary).setDisabled(!ud.homeChannelId),
        new ButtonBuilder().setCustomId('action_uninvite').setLabel('🚪 เตะออก').setStyle(ButtonStyle.Danger).setDisabled(!ud.homeChannelId),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildStockPanel(userId) {
    const ud = getUser(userId);
    const stocks = loadStocks();
    const port = ud.portfolio || {};

    const embed = new EmbedBuilder()
        .setColor(0x00d4aa)
        .setTitle('📊 Panel — ตลาดหุ้น')
        .setDescription(Object.values(stocks).map(s => {
            const a = s.change > 0 ? '📈' : s.change < 0 ? '📉' : '➡️';
            const own = port[s.symbol]?.amount ? ` • ถือ ${port[s.symbol].amount}` : '';
            return `${s.emoji} **${s.symbol}** ${s.price.toLocaleString()} บาท ${a} \`${s.change > 0 ? '+' : ''}${s.change}%\`${own}`;
        }).join('\n'))
        .setFooter({ text: 'อัปเดตทุก 5 นาที' })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_stock_buy').setLabel('📈 ซื้อหุ้น').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('action_stock_sell').setLabel('📉 ขายหุ้น').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('action_stock_portfolio').setLabel('📊 พอร์ต').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildQRPanel(userId) {
    const embed = new EmbedBuilder()
        .setColor(0x2c2f33)
        .setTitle('📲 Panel — QR Code')
        .setDescription('สร้าง QR Code ให้คนอื่นสแกนเพื่อโอนเงินให้คุณ\nหรือใช้ `/scanqr` แนบรูป QR เพื่อโอนเงินให้คนอื่น')
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_qr_generate').setLabel('📲 สร้าง QR').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildLotteryPanel(userId) {
    const ud = getUser(userId);
    const lottery = loadLottery();

    // เวลาที่เหลือถึงเที่ยงคืน
    const ms = msTillMidnightBKK();
    const hours = Math.floor(ms / 3600_000);
    const mins  = Math.floor((ms % 3600_000) / 60_000);

    const myTickets = lottery.tickets.filter(t => t.userId === userId);

    let lastText = '—';
    const r = lottery.lastResult;
    if (r) {
        if (!r.drawn) {
            lastText = r.note || '—';
        } else if (r.winners.length) {
            const nameList = r.winners.map(w => w.charName).join(', ');
            lastText = `🎯 เลขออก: **${r.drawn}**\n🏆 ผู้ชนะ: ${nameList}\n💰 รางวัล: ${r.prize.toLocaleString()} บาท/คน`;
        } else {
            lastText = `🎯 เลขออก: **${r.drawn}**\n😢 ${r.note}`;
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🎰 Panel — ลอตเตอรี่รายวัน')
        .setDescription('เลือกเลข 1–99 ราคา **100 บาท/ใบ** • ออกรางวัลเที่ยงคืน\nผู้ชนะแบ่งกัน **70%** ของพูล')
        .addFields(
            { name: '💰 พูลสะสมวันนี้', value: `${lottery.pool.toLocaleString()} บาท`, inline: true },
            { name: '⏰ ออกรางวัลใน', value: `${hours} ชม. ${mins} นาที`, inline: true },
            { name: '🎟️ สลากของคุณวันนี้', value: myTickets.length ? myTickets.map(t => `เลข **${t.number}**`).join(' • ') : '(ยังไม่ซื้อ)', inline: false },
            { name: '📋 ผลรางวัลล่าสุด', value: lastText, inline: false },
        )
        .setFooter({ text: `กระเป๋า: ${ud.balance.toLocaleString()} บาท` })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_lottery_buy').setLabel('🎟️ ซื้อสลาก 100 บาท').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

function buildSettingsPanel(userId) {
    const ud = getUser(userId);
    const hasPIN       = !!ud.pinHash;
    const hasBio       = !!ud.bio;
    const embedColor   = ud.embedColor || null;
    const noTimeout    = !!ud.noSessionTimeout;

    const embed = new EmbedBuilder()
        .setColor(embedColor || 0x5865f2)
        .setTitle('⚙️ Panel — ตั้งค่าบัญชี')
        .setDescription(ud.loggedIn ? `**${ud.charName}** — จัดการการตั้งค่าบัญชีของคุณ` : '⚠️ กรุณาเข้าสู่ระบบก่อน')
        .addFields(
            { name: '🔢 PIN', value: hasPIN ? '🟢 ตั้งค่าแล้ว' : '🔴 ยังไม่ได้ตั้ง', inline: true },
            { name: '📝 Bio', value: hasBio ? `"${ud.bio.slice(0, 40)}${ud.bio.length > 40 ? '…' : ''}"` : '(ว่าง)', inline: true },
            { name: '🎨 Embed Color', value: embedColor ? `#${embedColor.toString(16).padStart(6, '0').toUpperCase()}` : '(ค่าเริ่มต้น)', inline: true },
            { name: '⏱️ Session Timeout', value: noTimeout ? '🔕 **ปิด** — ไม่ต้อง login ซ้ำ' : '🔔 **เปิด** — หมดอายุทุก 5 นาที', inline: false },
        )
        .setFooter({ text: 'PIN ใช้ยืนยันธุรกรรมสำคัญ | Bio แสดงในโปรไฟล์' })
        .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_set_pin').setLabel('🔢 ตั้ง PIN').setStyle(ButtonStyle.Primary).setDisabled(!ud.loggedIn),
        new ButtonBuilder().setCustomId('action_set_bio').setLabel('📝 ตั้ง Bio').setStyle(ButtonStyle.Primary).setDisabled(!ud.loggedIn),
        new ButtonBuilder().setCustomId('action_set_embed').setLabel('🎨 ตั้งสี Embed').setStyle(ButtonStyle.Primary).setDisabled(!ud.loggedIn),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('action_toggle_session')
            .setLabel(noTimeout ? '🔔 เปิด Session Timeout' : '🔕 ปิด Session Timeout')
            .setStyle(noTimeout ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(!ud.loggedIn),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row1, row2], ephemeral: true };
}

function buildInboxPanel(userId) {
    const ud = getUser(userId);
    const msgs = ud.inbox || [];

    const embed = new EmbedBuilder()
        .setColor(ud.embedColor || 0x5865f2)
        .setTitle('📬 กล่องขาเข้า')
        .setDescription(msgs.length
            ? msgs.map((m, i) => {
                const ago = Date.now() - m.time;
                const mins = Math.floor(ago / 60_000);
                const hrs  = Math.floor(ago / 3_600_000);
                const days = Math.floor(ago / 86_400_000);
                const timeStr = days > 0 ? `${days}ว` : hrs > 0 ? `${hrs}ชม` : mins > 0 ? `${mins}น` : 'เมื่อกี้';
                return `${m.icon} **[${timeStr}]** ${m.text}`;
              }).join('\n')
            : '📭 ไม่มีข้อความ')
        .setFooter({ text: `${msgs.length}/30 ข้อความ` })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('action_inbox_clear').setLabel('🗑️ ล้างทั้งหมด').setStyle(ButtonStyle.Danger).setDisabled(!msgs.length),
        new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row], ephemeral: true };
}

// ════════════════════════════════════════════════════════════════════════════════
// INTERACTION HANDLER
// ════════════════════════════════════════════════════════════════════════════════

client.on('interactionCreate', async interaction => {

    // ══════════════════════════════════════════════════════════════════════════
    // SLASH COMMANDS
    // ══════════════════════════════════════════════════════════════════════════

    if (interaction.isChatInputCommand()) {
        const { commandName, user } = interaction;

        // ── /panel ────────────────────────────────────────────────────────────
        if (commandName === 'panel') {
            return interaction.reply(buildMainPanel(user.id));
        }

        // ── /login ────────────────────────────────────────────────────────────
        if (commandName === 'login') {
            const ud = getUser(user.id);

            // มีบัญชีแล้ว — เช็ครหัสผ่าน
            if (ud.loggedIn) {
                if (isSessionActive(user.id)) {
                    const j = JOBS[ud.jobKey] || JOBS.farmer;
                    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('✅ เข้าสู่ระบบอยู่แล้ว').setDescription(`ยินดีต้อนรับ **${ud.charName}**!\n${j.emoji} ${j.name} | 💵 ${ud.balance.toLocaleString()} บาท`)], ephemeral: true });
                }
                // มีบัญชีแต่ไม่มี session → ให้แนะนำไปใช้ /panel
                return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('🔐 กรุณา Login ผ่าน Panel').setDescription(`คุณมีบัญชีชื่อ **${ud.charName}** อยู่แล้ว\nใช้ \`/panel\` → **🔐 เข้าสู่ระบบ** เพื่อกรอกรหัสผ่าน`)], ephemeral: true });
            }

            // ยังไม่มีบัญชี → สมัคร (ไม่มี password option ใน slash ให้ใช้ /panel แทน)
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📝 สมัครสมาชิกผ่าน Panel').setDescription('ใช้คำสั่ง `/panel` → **👤 ตัวละคร** → **📝 สมัครสมาชิก**\nเพื่อกรอกชื่อ, อาชีพ และตั้งรหัสผ่านได้เลย!')], ephemeral: true });
        }

        // ── /balance ──────────────────────────────────────────────────────────
        if (commandName === 'balance') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0099ff).setTitle(`💳 ยอดเงินของ ${ud.charName || user.username}`).addFields({ name: '💵 กระเป๋า', value: `${ud.balance.toLocaleString()} บาท`, inline: true }, { name: '🏦 ธนาคาร', value: `${ud.deposited.toLocaleString()} บาท`, inline: true }, { name: '💎 รวม', value: `${(ud.balance + ud.deposited).toLocaleString()} บาท`, inline: false }).setTimestamp()] });
        }

        // ── /work ─────────────────────────────────────────────────────────────
        if (commandName === 'work') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (ud.lastWork) { const r = 30 * 60 * 1000 - (Date.now() - ud.lastWork); if (r > 0) return interaction.reply({ content: `⏳ รออีก **${Math.ceil(r / 60000)} นาที**`, ephemeral: true }); }
            const job = JOBS[ud.jobKey] || JOBS.farmer;
            const earned = Math.floor(Math.random() * (job.max - job.min + 1)) + job.min;
            updateUser(user.id, { balance: ud.balance + earned, lastWork: Date.now() });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${job.emoji} ทำงานสำเร็จ!`).setDescription(`**${ud.charName || user.username}** ทำงาน **${job.name}** ได้รับ **${earned.toLocaleString()} บาท**`).addFields({ name: '💵 เงินใหม่', value: `${(ud.balance + earned).toLocaleString()} บาท`, inline: true }).setTimestamp()] });
        }

        // ── /give ─────────────────────────────────────────────────────────────
        if (commandName === 'give') {
            if (!requireLogin(interaction)) return;
            const target = interaction.options.getUser('user');
            const amount = interaction.options.getInteger('amount');
            if (target.id === user.id) return interaction.reply({ content: '❌ ไม่สามารถโอนให้ตัวเองได้!', ephemeral: true });
            const sender = getUser(user.id); const receiver = getUser(target.id);
            if (!receiver.loggedIn) return interaction.reply({ content: '❌ ผู้รับยังไม่ได้เข้าสู่ระบบ!', ephemeral: true });
            if (sender.balance < amount) return interaction.reply({ content: `❌ เงินไม่พอ! มีแค่ ${sender.balance.toLocaleString()} บาท`, ephemeral: true });
            updateUser(user.id, { balance: sender.balance - amount }); updateUser(target.id, { balance: receiver.balance + amount });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('💸 โอนเงินสำเร็จ!').addFields({ name: '📤 ผู้โอน', value: sender.charName || user.username, inline: true }, { name: '📥 ผู้รับ', value: receiver.charName || target.username, inline: true }, { name: '💵 จำนวน', value: `${amount.toLocaleString()} บาท`, inline: false }).setTimestamp()] });
        }

        // ── /deploysit / /withdraw ────────────────────────────────────────────
        if (commandName === 'deploysit') {
            if (!requireLogin(interaction)) return;
            const amount = interaction.options.getInteger('amount');
            const ud = getUser(user.id);
            if (ud.balance < amount) return interaction.reply({ content: `❌ เงินไม่พอ! มีแค่ ${ud.balance.toLocaleString()} บาท`, ephemeral: true });
            updateUser(user.id, { balance: ud.balance - amount, deposited: ud.deposited + amount });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0099ff).setTitle('🏦 ฝากเงินสำเร็จ!').addFields({ name: '💵 ฝาก', value: `${amount.toLocaleString()} บาท`, inline: true }, { name: '🏦 ยอดธนาคาร', value: `${(ud.deposited + amount).toLocaleString()} บาท`, inline: true }, { name: '💰 กระเป๋า', value: `${(ud.balance - amount).toLocaleString()} บาท`, inline: true }).setTimestamp()] });
        }
        if (commandName === 'withdraw') {
            if (!requireLogin(interaction)) return;
            const amount = interaction.options.getInteger('amount');
            const ud = getUser(user.id);
            if (ud.deposited < amount) return interaction.reply({ content: `❌ เงินในธนาคารไม่พอ! มีแค่ ${ud.deposited.toLocaleString()} บาท`, ephemeral: true });
            updateUser(user.id, { balance: ud.balance + amount, deposited: ud.deposited - amount });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('💰 ถอนเงินสำเร็จ!').addFields({ name: '🏦 ถอนจาก', value: `${amount.toLocaleString()} บาท`, inline: true }, { name: '💵 กระเป๋า', value: `${(ud.balance + amount).toLocaleString()} บาท`, inline: true }, { name: '🏦 ธนาคารคงเหลือ', value: `${(ud.deposited - amount).toLocaleString()} บาท`, inline: true }).setTimestamp()] });
        }

        // ── /newshop ──────────────────────────────────────────────────────────
        if (commandName === 'newshop') {
            if (!requireLogin(interaction)) return;
            await handleNewShop(interaction, interaction.options.getString('name'));
            return;
        }

        if (commandName === 'openshop') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
            if (ud.shopOpen) return interaction.reply({ content: '❌ เปิดอยู่แล้ว!', ephemeral: true });
            updateUser(user.id, { shopOpen: true });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🟢 เปิดร้านสำเร็จ!').setDescription(`ร้าน **${ud.shop}** เปิดให้บริการแล้ว`)] });
        }
        if (commandName === 'closeshop') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
            if (!ud.shopOpen) return interaction.reply({ content: '❌ ปิดอยู่แล้ว!', ephemeral: true });
            updateUser(user.id, { shopOpen: false });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setTitle('🔴 ปิดร้านสำเร็จ!').setDescription(`ร้าน **${ud.shop}** ปิดแล้ว`)] });
        }

        // ── /addmenu ──────────────────────────────────────────────────────────
        if (commandName === 'addmenu') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
            const itemName = interaction.options.getString('name');
            const price = interaction.options.getInteger('price');
            const desc = interaction.options.getString('description') || '';
            const stockInput = interaction.options.getInteger('stock');
            const menu = ud.shopMenu || [];
            if (menu.length >= 20) return interaction.reply({ content: '❌ เมนูเต็ม! สูงสุด 20 รายการ', ephemeral: true });
            if (menu.find(m => m.name.toLowerCase() === itemName.toLowerCase())) return interaction.reply({ content: `❌ มี **${itemName}** อยู่แล้ว!`, ephemeral: true });
            menu.push({ name: itemName, price, description: desc, stock: stockInput ?? null });
            updateUser(user.id, { shopMenu: menu });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ เพิ่มสินค้าสำเร็จ!').addFields({ name: '🛒 ชื่อ', value: itemName, inline: true }, { name: '💵 ราคา', value: `${price.toLocaleString()} บาท`, inline: true }, { name: '📦 สต็อก', value: stockInput != null ? `${stockInput} ชิ้น` : '♾️ ไม่จำกัด', inline: true }, { name: '📝 รายละเอียด', value: desc || '(ไม่มี)', inline: false }).setTimestamp()] });
        }
        if (commandName === 'removemenu') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
            const name = interaction.options.getString('name');
            const menu = ud.shopMenu || [];
            const idx = menu.findIndex(m => m.name.toLowerCase() === name.toLowerCase());
            if (idx === -1) return interaction.reply({ content: `❌ ไม่พบ **${name}**`, ephemeral: true });
            const removed = menu.splice(idx, 1)[0];
            updateUser(user.id, { shopMenu: menu });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff6600).setTitle('🗑️ ลบสำเร็จ!').addFields({ name: '🛒 สินค้าที่ลบ', value: removed.name, inline: true }, { name: '💵 ราคาเดิม', value: `${removed.price.toLocaleString()} บาท`, inline: true }).setTimestamp()] });
        }

        // ── /menu ─────────────────────────────────────────────────────────────
        if (commandName === 'menu') {
            const target = interaction.options.getUser('user');
            const owner = getUser(target.id);
            if (!owner.loggedIn) return interaction.reply({ content: '❌ ผู้ใช้ยังไม่ได้เข้าสู่ระบบ!', ephemeral: true });
            if (!owner.shop) return interaction.reply({ content: '❌ ผู้ใช้ยังไม่มีร้านค้า!', ephemeral: true });
            const menu = owner.shopMenu || [];
            const embed = new EmbedBuilder().setColor(owner.shopOpen ? 0xff9900 : 0x888888).setTitle(`📋 เมนูร้าน ${owner.shop}`).setDescription(`<@${target.id}>${owner.charName ? ` (${owner.charName})` : ''} | **${owner.shopOpen ? '🟢 เปิด' : '🔴 ปิด'}**`).setThumbnail(target.displayAvatarURL({ size: 128 })).setFooter({ text: `สั่งซื้อด้วย /order @${target.username} <ชื่อสินค้า>` }).setTimestamp();
            if (!menu.length) { embed.addFields({ name: '📭 ว่าง', value: 'ยังไม่มีสินค้า' }); }
            else { menu.forEach((item, i) => { const s = item.stock == null ? '♾️' : item.stock > 0 ? `📦${item.stock}` : '❌หมด'; embed.addFields({ name: `${i + 1}. ${item.stock === 0 ? '~~' : ''}${item.name}${item.stock === 0 ? '~~' : ''}`, value: `💵 **${item.price.toLocaleString()} บาท** | ${s}${item.description ? `\n📝 ${item.description}` : ''}`, inline: true }); }); }
            return interaction.reply({ embeds: [embed] });
        }

        // ── /order ────────────────────────────────────────────────────────────
        if (commandName === 'order') {
            if (!requireLogin(interaction)) return;
            await handleOrder(interaction, interaction.options.getUser('user'), interaction.options.getString('item'), interaction.options.getInteger('quantity') || 1);
            return;
        }

        // ── /restock ──────────────────────────────────────────────────────────
        if (commandName === 'restock') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
            const name = interaction.options.getString('name');
            const qty = interaction.options.getInteger('quantity');
            const menu = ud.shopMenu || [];
            const item = menu.find(m => m.name.toLowerCase() === name.toLowerCase());
            if (!item) return interaction.reply({ content: `❌ ไม่พบ **${name}**`, ephemeral: true });
            if (item.stock == null) return interaction.reply({ content: '❌ สินค้านี้ไม่มีสต็อก (ไม่จำกัด)', ephemeral: true });
            const before = item.stock; item.stock += qty;
            updateUser(user.id, { shopMenu: menu });
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('📦 เติมสต็อกสำเร็จ!').addFields({ name: '🛒 สินค้า', value: item.name, inline: true }, { name: '➕ เพิ่ม', value: `${qty} ชิ้น`, inline: true }, { name: '📦 รวม', value: `${before} → **${item.stock}**`, inline: true }).setTimestamp()] });
        }

        // ── /inventory ────────────────────────────────────────────────────────
        if (commandName === 'inventory') {
            if (!requireLogin(interaction)) return;
            const target = interaction.options.getUser('user') || user;
            const owner = getUser(target.id);
            if (!owner.loggedIn) return interaction.reply({ content: '❌ ผู้ใช้ยังไม่ได้เข้าสู่ระบบ!', ephemeral: true });
            if (!owner.shop) return interaction.reply({ content: '❌ ผู้ใช้ยังไม่มีร้านค้า!', ephemeral: true });
            const menu = owner.shopMenu || [];
            const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`📦 Inventory ร้าน ${owner.shop}`).setDescription(`<@${target.id}>${owner.charName ? ` (${owner.charName})` : ''}`).setTimestamp();
            if (!menu.length) { embed.addFields({ name: '📭 ว่าง', value: 'เพิ่มสินค้าด้วย /addmenu' }); }
            else { menu.forEach(item => { const s = item.stock == null ? '♾️ ไม่จำกัด' : item.stock > 0 ? `✅ ${item.stock} ชิ้น` : '❌ หมด'; const bar = item.stock == null ? '██████████' : item.stock === 0 ? '░░░░░░░░░░' : '█'.repeat(Math.min(10, Math.ceil(item.stock / 5))) + '░'.repeat(Math.max(0, 10 - Math.ceil(item.stock / 5))); embed.addFields({ name: `🛒 ${item.name}`, value: `${s}\n\`${bar}\``, inline: true }); }); }
            return interaction.reply({ embeds: [embed] });
        }

        // ── /hire / /fire / /staff ────────────────────────────────────────────
        if (commandName === 'hire') {
            if (!requireLogin(interaction)) return;
            await handleHire(interaction, interaction.options.getUser('user'), interaction.options.getString('role') || 'พนักงาน');
            return;
        }
        if (commandName === 'fire') {
            if (!requireLogin(interaction)) return;
            await handleFire(interaction, interaction.options.getUser('user'));
            return;
        }
        if (commandName === 'staff') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
            const staff = ud.shopStaff || [];
            const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`👥 พนักงานร้าน ${ud.shop}`).setDescription(staff.length ? `**${staff.length} คน**` : 'ยังไม่มีพนักงาน').setTimestamp();
            staff.forEach((s, i) => embed.addFields({ name: `${i + 1}. <@${s.id}>`, value: `👔 ${s.role}\n📅 ${new Date(s.hiredAt).toLocaleDateString('th-TH')}`, inline: true }));
            return interaction.reply({ embeds: [embed] });
        }

        // ── /newhome ──────────────────────────────────────────────────────────
        if (commandName === 'newhome') {
            if (!requireLogin(interaction)) return;
            await handleNewHome(interaction, interaction.options.getString('name'));
            return;
        }
        if (commandName === 'invite') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.homeChannelId) return interaction.reply({ content: '❌ ยังไม่มีบ้าน!', ephemeral: true });
            const target = interaction.options.getUser('user');
            try {
                const ch = await client.channels.fetch(ud.homeChannelId);
                await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ReadMessageHistory]: true });
                await ch.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setDescription(`🏠 ยินดีต้อนรับ <@${target.id}> เข้าสู่บ้าน!`)] });
                return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ เชิญสำเร็จ!').setDescription(`<@${target.id}> ได้สิทธิ์เข้าบ้านแล้ว`)] });
            } catch { return interaction.reply({ content: '❌ เกิดข้อผิดพลาด', ephemeral: true }); }
        }
        if (commandName === 'uninvite') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!ud.homeChannelId) return interaction.reply({ content: '❌ ยังไม่มีบ้าน!', ephemeral: true });
            const target = interaction.options.getUser('user');
            try {
                const ch = await client.channels.fetch(ud.homeChannelId);
                await ch.permissionOverwrites.edit(target.id, { [PermissionFlagsBits.ViewChannel]: false, [PermissionFlagsBits.SendMessages]: false });
                await ch.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription(`🚪 <@${target.id}> ถูกเตะออกจากบ้าน`)] });
                return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setTitle('🚪 เตะออกสำเร็จ!').setDescription(`<@${target.id}> ถูกถอดสิทธิ์แล้ว`)] });
            } catch { return interaction.reply({ content: '❌ เกิดข้อผิดพลาด', ephemeral: true }); }
        }

        // ── /qrscan / /scanqr ─────────────────────────────────────────────────
        if (commandName === 'qrscan') {
            if (!requireLogin(interaction)) return;
            await interaction.deferReply();
            const ud = getUser(user.id);
            const qrPath = `./qr_${user.id}.png`;
            await QRCode.toFile(qrPath, JSON.stringify({ userId: user.id, username: ud.charName || user.username, type: 'payment' }), { width: 300, margin: 2 });
            const att = new AttachmentBuilder(qrPath, { name: 'qrcode.png' });
            await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x0099ff).setTitle('📲 QR Code ของคุณ').setDescription(`**${ud.charName || user.username}** — ให้คนอื่นสแกนเพื่อโอนเงินให้คุณ`).addFields({ name: '💵 ยอดเงิน', value: `${ud.balance.toLocaleString()} บาท`, inline: true }).setImage('attachment://qrcode.png').setTimestamp()], files: [att] });
            setTimeout(() => { try { fs.unlinkSync(qrPath); } catch {} }, 10000);
            return;
        }
        if (commandName === 'scanqr') {
            if (!requireLogin(interaction)) return;
            await interaction.deferReply();
            const att = interaction.options.getAttachment('qr');
            const amount = interaction.options.getInteger('amount');
            if (!att.contentType?.startsWith('image/')) return interaction.editReply({ content: '❌ กรุณาอัปโหลดรูปภาพ!' });
            try {
                const buf = await downloadImage(att.url);
                const img = await Jimp.read(buf);
                const code = jsQR(img.bitmap.data, img.bitmap.width, img.bitmap.height);
                if (!code) return interaction.editReply({ content: '❌ แสกน QR ไม่ได้!' });
                let payload; try { payload = JSON.parse(code.data); } catch { return interaction.editReply({ content: '❌ QR ไม่ใช่ของระบบ!' }); }
                if (payload.type !== 'payment') return interaction.editReply({ content: '❌ QR นี้ไม่ใช่ QR รับเงิน!' });
                if (payload.userId === user.id) return interaction.editReply({ content: '❌ ไม่สามารถโอนให้ตัวเองได้!' });
                const sender = getUser(user.id); const receiver = getUser(payload.userId);
                if (!receiver.loggedIn) return interaction.editReply({ content: '❌ เจ้าของ QR ยังไม่ได้เข้าสู่ระบบ!' });
                if (sender.balance < amount) return interaction.editReply({ content: `❌ เงินไม่พอ! มีแค่ ${sender.balance.toLocaleString()} บาท` });
                updateUser(user.id, { balance: sender.balance - amount }); updateUser(payload.userId, { balance: receiver.balance + amount });
                await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ โอนเงินสำเร็จ!').addFields({ name: '📤 ผู้โอน', value: sender.charName || user.username, inline: true }, { name: '📥 ผู้รับ', value: receiver.charName || payload.username, inline: true }, { name: '💵 จำนวน', value: `${amount.toLocaleString()} บาท`, inline: false }, { name: '💰 เงินคงเหลือ', value: `${(sender.balance - amount).toLocaleString()} บาท`, inline: true }).setTimestamp()] });
                try { const rxUser = await client.users.fetch(payload.userId); const slip = new AttachmentBuilder(await downloadImage(att.url), { name: 'slip.png' }); await rxUser.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('💰 เงินเข้าแล้ว!').addFields({ name: '📤 ผู้โอน', value: sender.charName || user.username, inline: true }, { name: '💵 จำนวน', value: `${amount.toLocaleString()} บาท`, inline: true }, { name: '🏦 ยอดใหม่', value: `${(receiver.balance + amount).toLocaleString()} บาท`, inline: true }).setImage('attachment://slip.png').setTimestamp()], files: [slip] }); } catch {}
            } catch (e) { console.error(e); return interaction.editReply({ content: '❌ เกิดข้อผิดพลาด' }); }
            return;
        }

        // ── /profile / /shoplist / /job / /help / /setdeposit / /stock ────────
        if (commandName === 'profile') {
            const target = interaction.options.getUser('user') || user;
            const ud = getUser(target.id);
            if (!ud.loggedIn) return interaction.reply({ content: `❌ **${target.username}** ยังไม่ได้เข้าสู่ระบบ!`, ephemeral: true });
            const job = JOBS[ud.jobKey]; let work = '✅ พร้อม';
            if (ud.lastWork) { const r = 30 * 60 * 1000 - (Date.now() - ud.lastWork); if (r > 0) work = `⏳ ${Math.ceil(r / 60000)} นาที`; }
            const s = ud.settings || {};
            const embed = new EmbedBuilder().setColor(s.color ? parseInt(s.color, 16) : 0x5865f2).setTitle(`👤 ${ud.charName || target.username}`).setThumbnail(target.displayAvatarURL({ size: 256 })).setTimestamp();
            if (s.bio) embed.setDescription(`> ${s.bio}`);
            embed.addFields({ name: '🪪 ตัวละคร', value: ud.charName || '-', inline: true }, { name: `${job ? job.emoji : '💼'} อาชีพ`, value: job ? job.name : '-', inline: true }, { name: '💵 กระเป๋า', value: `${ud.balance.toLocaleString()} บาท`, inline: true }, { name: '🏦 ธนาคาร', value: `${ud.deposited.toLocaleString()} บาท`, inline: true }, { name: '🏪 ร้านค้า', value: ud.shop ? `${ud.shopOpen ? '🟢' : '🔴'} ${ud.shop}` : 'ไม่มีร้าน', inline: true }, { name: '🏠 บ้าน', value: ud.home || 'ไม่มีบ้าน', inline: true }, { name: '💼 งาน', value: work, inline: true });
            return interaction.reply({ embeds: [embed] });
        }
        if (commandName === 'shoplist') {
            const data = loadData();
            const shops = Object.entries(data).filter(([, u]) => u.shop && u.shopOpen).map(([id, u]) => ({ id, shop: u.shop, char: u.charName }));
            const embed = new EmbedBuilder().setColor(0xff9900).setTitle('🏪 ร้านค้าที่เปิดอยู่');
            if (!shops.length) embed.setDescription('ยังไม่มีร้านที่เปิดอยู่');
            else { embed.setDescription(`เปิดอยู่ **${shops.length} ร้าน**`); shops.forEach((s, i) => embed.addFields({ name: `${i + 1}. 🏪 ${s.shop}`, value: `<@${s.id}>${s.char ? ` (${s.char})` : ''}`, inline: true })); }
            return interaction.reply({ embeds: [embed.setTimestamp()] });
        }
        if (commandName === 'job') {
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('💼 อาชีพทั้งหมด').setDescription('ใช้ `/panel` → **ตัวละคร** → **สร้างตัวละคร** เพื่อเลือกอาชีพ').addFields(Object.values(JOBS).map(j => ({ name: `${j.emoji} ${j.name}`, value: `${j.desc}\n💵 **${j.min}–${j.max} บาท**`, inline: true }))).setTimestamp()] });
        }
        if (commandName === 'help') {
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📖 ช่วยเหลือ').setDescription('ใช้ `/panel` เพื่อเข้าสู่ระบบทั้งหมดผ่านปุ่ม!\n\nหรือใช้ slash commands ตรงๆ ด้านล่าง').addFields({ name: '👤 ตัวละคร', value: '`/login` `/balance` `/work` `/give` `/profile`', inline: false }, { name: '🏪 ร้านค้า', value: '`/newshop` `/openshop` `/closeshop` `/menu` `/order`', inline: false }, { name: '📦 สต็อก', value: '`/addmenu` `/removemenu` `/restock` `/inventory`', inline: false }, { name: '👥 พนักงาน', value: '`/hire` `/fire` `/staff`', inline: false }, { name: '🏠 บ้าน', value: '`/newhome` `/invite` `/uninvite`', inline: false }, { name: '💰 การเงิน', value: '`/deploysit` `/withdraw` `/qrscan` `/scanqr`', inline: false }, { name: '📊 หุ้น', value: '`/stock list/buy/sell/portfolio`', inline: false }).setFooter({ text: '💡 แนะนำ: ใช้ /panel สะดวกกว่า!' }).setTimestamp()] });
        }
        if (commandName === 'lottery') {
            const lottery = loadLottery();
            const ms = msTillMidnightBKK();
            const hours = Math.floor(ms / 3600_000);
            const mins  = Math.floor((ms % 3600_000) / 60_000);
            const r = lottery.lastResult;
            let lastText = '—';
            if (r) {
                if (!r.drawn) lastText = r.note || '—';
                else if (r.winners.length) lastText = `🎯 เลขออก: **${r.drawn}** — ผู้ชนะ: ${r.winners.map(w => w.charName).join(', ')} (+${r.prize.toLocaleString()} บาท)`;
                else lastText = `🎯 เลขออก: **${r.drawn}** — ${r.note}`;
            }
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffd700).setTitle('🎰 ลอตเตอรี่รายวัน').setDescription('ซื้อสลากผ่าน `/panel` → **🎰 ลอตเตอรี่รายวัน**').addFields({ name: '💰 พูลสะสมวันนี้', value: `${lottery.pool.toLocaleString()} บาท`, inline: true }, { name: '⏰ ออกรางวัลใน', value: `${hours} ชม. ${mins} นาที`, inline: true }, { name: '🎟️ ใบที่ขายไปแล้ว', value: `${lottery.tickets.length} ใบ`, inline: true }, { name: '📋 ผลล่าสุด', value: lastText }).setFooter({ text: 'ราคา 100 บาท/ใบ • เลข 1–99 • ผู้ชนะรับ 70%' }).setTimestamp()], ephemeral: true });
        }

        if (commandName === 'setdeposit') {
            const ch = interaction.options.getChannel('channel');
            const cfg = loadConfig(); if (!cfg[interaction.guildId]) cfg[interaction.guildId] = {}; cfg[interaction.guildId].depositChannelId = ch.id; saveConfig(cfg);
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ ตั้งค่าสำเร็จ!').setDescription(`ประกาศฝากเงินใน <#${ch.id}>`)], ephemeral: true });
        }
        if (commandName === 'stock') {
            if (!requireLogin(interaction)) return;
            const sub = interaction.options.getSubcommand(); const stocks = loadStocks(); const ud = getUser(user.id);
            if (sub === 'list') { return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00d4aa).setTitle('📊 ตลาดหุ้น').setDescription(Object.values(stocks).map(s => { const a = s.change > 0 ? '📈' : s.change < 0 ? '📉' : '➡️'; return `${s.emoji} **${s.symbol}** ${s.price.toLocaleString()} บาท ${a} \`${s.change > 0 ? '+' : ''}${s.change}%\``; }).join('\n')).setFooter({ text: 'อัปเดตทุก 5 นาที' }).setTimestamp()] }); }
            if (sub === 'buy') { const sym = interaction.options.getString('symbol'); const amt = interaction.options.getInteger('amount'); const s = stocks[sym]; const cost = s.price * amt; if (ud.balance < cost) return interaction.reply({ content: `❌ เงินไม่พอ! ต้องใช้ ${cost.toLocaleString()} บาท`, ephemeral: true }); const port = ud.portfolio || {}; if (!port[sym]) port[sym] = { amount: 0, avgCost: 0 }; port[sym].avgCost = Math.round(((port[sym].avgCost * port[sym].amount) + cost) / (port[sym].amount + amt)); port[sym].amount += amt; updateUser(user.id, { balance: ud.balance - cost, portfolio: port }); stocks[sym].volume += amt; saveStocks(stocks); return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ ซื้อหุ้นสำเร็จ!').addFields({ name: `${s.emoji} ${sym}`, value: `x${amt}`, inline: true }, { name: '🧾 ยอด', value: `${cost.toLocaleString()} บาท`, inline: true }, { name: '💵 เงินคงเหลือ', value: `${(ud.balance - cost).toLocaleString()} บาท`, inline: true }).setTimestamp()] }); }
            if (sub === 'sell') { const sym = interaction.options.getString('symbol'); const amt = interaction.options.getInteger('amount'); const s = stocks[sym]; const port = ud.portfolio || {}; if (!port[sym] || port[sym].amount < amt) return interaction.reply({ content: `❌ หุ้นไม่พอ! มีแค่ ${port[sym]?.amount || 0}`, ephemeral: true }); const earned = s.price * amt; const pl = (s.price - port[sym].avgCost) * amt; port[sym].amount -= amt; if (!port[sym].amount) delete port[sym]; updateUser(user.id, { balance: ud.balance + earned, portfolio: port }); stocks[sym].volume += amt; saveStocks(stocks); return interaction.reply({ embeds: [new EmbedBuilder().setColor(pl >= 0 ? 0x57f287 : 0xed4245).setTitle(pl >= 0 ? '💹 ขายกำไร!' : '📉 ขายขาดทุน').addFields({ name: '🧾 ยอดรับ', value: `${earned.toLocaleString()} บาท`, inline: true }, { name: pl >= 0 ? '📈 กำไร' : '📉 ขาดทุน', value: `${pl >= 0 ? '+' : ''}${pl.toLocaleString()} บาท`, inline: true }, { name: '💵 เงินใหม่', value: `${(ud.balance + earned).toLocaleString()} บาท`, inline: true }).setTimestamp()] }); }
            if (sub === 'portfolio') { const port = ud.portfolio || {}; const keys = Object.keys(port).filter(k => port[k].amount > 0); if (!keys.length) return interaction.reply({ content: '📭 ยังไม่มีหุ้นในพอร์ต', ephemeral: true }); let tv = 0, tc = 0; const lines = keys.map(sym => { const s = stocks[sym]; const p = port[sym]; const v = s.price * p.amount; const c = p.avgCost * p.amount; const pl = v - c; tv += v; tc += c; return `${s.emoji} **${sym}** x${p.amount} | ${v.toLocaleString()} บาท | ${pl >= 0 ? '📈+' : '📉'}${pl.toLocaleString()}`; }); const tpl = tv - tc; return interaction.reply({ embeds: [new EmbedBuilder().setColor(tpl >= 0 ? 0x57f287 : 0xed4245).setTitle(`📊 พอร์ตของ ${ud.charName || user.username}`).setDescription(lines.join('\n')).addFields({ name: '💎 รวม', value: `${tv.toLocaleString()} บาท`, inline: true }, { name: tpl >= 0 ? '📈 กำไร' : '📉 ขาดทุน', value: `${tpl >= 0 ? '+' : ''}${tpl.toLocaleString()} บาท`, inline: true }).setTimestamp()] }); }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BUTTON INTERACTIONS
    // ══════════════════════════════════════════════════════════════════════════

    if (interaction.isButton()) {
        const { customId, user } = interaction;

        // ── Panel navigation ──────────────────────────────────────────────────
        if (customId === 'panel_main' || customId === 'panel_refresh') {
            return interaction.update(buildMainPanel(user.id));
        }
        if (customId === 'panel_character') {
            return interaction.update(buildCharacterPanel(user.id));
        }
        if (customId === 'panel_finance') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildFinancePanel(user.id));
        }
        if (customId === 'panel_shop') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildShopPanel(user.id));
        }
        if (customId === 'panel_menu') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildMenuPanel(user.id));
        }
        if (customId === 'panel_stock_inv') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildInventoryPanel(user.id));
        }
        if (customId === 'panel_staff') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildStaffPanel(user.id));
        }
        if (customId === 'panel_home') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildHomePanel(user.id));
        }
        if (customId === 'panel_stock') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildStockPanel(user.id));
        }
        if (customId === 'panel_lottery') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildLotteryPanel(user.id));
        }
        if (customId === 'panel_qr') {
            if (!getUser(user.id).loggedIn) return interaction.update(buildCharacterPanel(user.id));
            return interaction.update(buildQRPanel(user.id));
        }
        if (customId === 'panel_settings') {
            return interaction.update(buildSettingsPanel(user.id));
        }
        if (customId === 'panel_inbox') {
            return interaction.update(buildInboxPanel(user.id));
        }
        if (customId === 'action_inbox_clear') {
            updateUser(user.id, { inbox: [] });
            return interaction.update(buildInboxPanel(user.id));
        }

        // ── Actions (open modals) ─────────────────────────────────────────────
        if (customId === 'action_lottery_buy') {
            if (!requireLogin(interaction)) return;
            const modal = new ModalBuilder().setCustomId('modal_lottery_buy').setTitle('🎟️ ซื้อสลากลอตเตอรี่');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('number').setLabel('เลือกเลข 1–99').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setPlaceholder('เช่น 7 หรือ 42')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('qty').setLabel('จำนวนใบ (1–10 ใบ) ราคา 100 บาท/ใบ').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setPlaceholder('เช่น 1')),
            );
            addPinFieldIfNeeded(modal, getUser(user.id));
            return interaction.showModal(modal);
        }

        if (customId === 'action_register') {
            const modal = new ModalBuilder().setCustomId('modal_register').setTitle('📝 สมัครสมาชิก');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('charname').setLabel('ชื่อตัวละคร').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30).setPlaceholder('เช่น นายโปรแกรมเมอร์')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('job').setLabel('อาชีพ: chef / builder / driver / programmer / delivery / farmer / trader / doctor').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น farmer')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('password').setLabel('ตั้งรหัสผ่าน (จำไว้ด้วย!)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(30).setPlaceholder('รหัสผ่านของคุณ')),
            );
            return interaction.showModal(modal);
        }

        if (customId === 'action_login') {
            const ud = getUser(user.id);
            if (!ud.loggedIn) return interaction.update(buildCharacterPanel(user.id));
            const modal = new ModalBuilder().setCustomId('modal_login').setTitle('🔐 เข้าสู่ระบบ');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('password').setLabel(`กรอกรหัสผ่านของ ${ud.charName}`).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('รหัสผ่านของคุณ')),
            );
            return interaction.showModal(modal);
        }

        if (customId === 'action_profile') {
            const ud = getUser(user.id); const job = JOBS[ud.jobKey]; let work = '✅ พร้อม';
            if (ud.lastWork) { const r = 30 * 60 * 1000 - (Date.now() - ud.lastWork); if (r > 0) work = `⏳ ${Math.ceil(r / 60000)} นาที`; }
            const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`👤 ${ud.charName}`).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields({ name: `${job ? job.emoji : '💼'} อาชีพ`, value: job ? job.name : '-', inline: true }, { name: '💵 กระเป๋า', value: `${ud.balance.toLocaleString()} บาท`, inline: true }, { name: '🏦 ธนาคาร', value: `${ud.deposited.toLocaleString()} บาท`, inline: true }, { name: '🏪 ร้านค้า', value: ud.shop ? `${ud.shopOpen ? '🟢' : '🔴'} ${ud.shop}` : 'ไม่มีร้าน', inline: true }, { name: '🏠 บ้าน', value: ud.home || 'ไม่มีบ้าน', inline: true }, { name: '💼 งาน', value: work, inline: true }).setTimestamp();
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('panel_main').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary));
            return interaction.update({ embeds: [embed], components: [row] });
        }

        if (customId === 'action_work') {
            const ud = getUser(user.id);
            if (ud.lastWork) { const r = 30 * 60 * 1000 - (Date.now() - ud.lastWork); if (r > 0) return interaction.reply({ content: `⏳ รออีก **${Math.ceil(r / 60000)} นาที**`, ephemeral: true }); }
            const job = JOBS[ud.jobKey] || JOBS.farmer;
            const earned = Math.floor(Math.random() * (job.max - job.min + 1)) + job.min;
            updateUser(user.id, { balance: ud.balance + earned, lastWork: Date.now() });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`${job.emoji} ทำงานสำเร็จ!`).setDescription(`ได้รับ **${earned.toLocaleString()} บาท**\n💵 กระเป๋า: ${(ud.balance + earned).toLocaleString()} บาท`).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildFinancePanel(user.id));
        }

        if (customId === 'action_deposit') {
            const ud = getUser(user.id);
            const modal = new ModalBuilder().setCustomId('modal_deposit').setTitle('🏦 ฝากเงิน');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel(`จำนวนเงินที่ฝาก (มีในกระเป๋า: ${ud.balance.toLocaleString()} บาท)`).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 500')));
            addPinFieldIfNeeded(modal, ud);
            return interaction.showModal(modal);
        }

        if (customId === 'action_withdraw') {
            const ud = getUser(user.id);
            const modal = new ModalBuilder().setCustomId('modal_withdraw').setTitle('💸 ถอนเงิน');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel(`จำนวนเงินที่ถอน (ธนาคาร: ${ud.deposited.toLocaleString()} บาท)`).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 500')));
            addPinFieldIfNeeded(modal, ud);
            return interaction.showModal(modal);
        }

        if (customId === 'action_give') {
            const ud = getUser(user.id);
            const modal = new ModalBuilder().setCustomId('modal_give').setTitle('🤝 โอนเงิน');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('Discord ID ของผู้รับ (คลิกขวา → Copy ID)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 123456789012345678')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('จำนวนเงิน (บาท)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 200')),
            );
            addPinFieldIfNeeded(modal, ud);
            return interaction.showModal(modal);
        }

        if (customId === 'action_newshop') {
            const modal = new ModalBuilder().setCustomId('modal_newshop').setTitle('🏗️ สร้างร้านค้า (500 บาท)');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('shop_name').setLabel('ชื่อร้านค้า').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30).setPlaceholder('เช่น ร้านขายของดี')));
            return interaction.showModal(modal);
        }

        if (customId === 'action_openshop') {
            const ud = getUser(user.id);
            if (!ud.shop || ud.shopOpen) return interaction.reply({ content: '❌ ไม่สามารถเปิดร้านได้', ephemeral: true });
            updateUser(user.id, { shopOpen: true });
            await interaction.reply({ content: `🟢 ร้าน **${ud.shop}** เปิดแล้ว!`, ephemeral: true });
            return interaction.message.edit(buildShopPanel(user.id));
        }

        if (customId === 'action_closeshop') {
            const ud = getUser(user.id);
            if (!ud.shop || !ud.shopOpen) return interaction.reply({ content: '❌ ไม่สามารถปิดร้านได้', ephemeral: true });
            updateUser(user.id, { shopOpen: false });
            await interaction.reply({ content: `🔴 ร้าน **${ud.shop}** ปิดแล้ว!`, ephemeral: true });
            return interaction.message.edit(buildShopPanel(user.id));
        }

        if (customId === 'action_shoplist') {
            const data = loadData();
            const shops = Object.entries(data).filter(([, u]) => u.shop && u.shopOpen).map(([id, u]) => ({ id, shop: u.shop, char: u.charName }));
            const embed = new EmbedBuilder().setColor(0xff9900).setTitle('🏪 ร้านค้าที่เปิดอยู่').setTimestamp();
            if (!shops.length) embed.setDescription('ยังไม่มีร้านที่เปิดอยู่');
            else shops.forEach((s, i) => embed.addFields({ name: `${i + 1}. 🏪 ${s.shop}`, value: `<@${s.id}>${s.char ? ` (${s.char})` : ''}`, inline: true }));
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('panel_shop').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary));
            return interaction.update({ embeds: [embed], components: [row] });
        }

        if (customId === 'action_addmenu') {
            const modal = new ModalBuilder().setCustomId('modal_addmenu').setTitle('➕ เพิ่มสินค้า');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_name').setLabel('ชื่อสินค้า').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_price').setLabel('ราคา (บาท)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 150')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_desc').setLabel('รายละเอียด (ไม่บังคับ)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_stock').setLabel('สต็อก (ตัวเลข หรือว่างไว้ = ไม่จำกัด)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('เช่น 50')),
            );
            return interaction.showModal(modal);
        }

        if (customId === 'action_removemenu') {
            const modal = new ModalBuilder().setCustomId('modal_removemenu').setTitle('🗑️ ลบสินค้า');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_name').setLabel('ชื่อสินค้าที่ต้องการลบ').setStyle(TextInputStyle.Short).setRequired(true)));
            return interaction.showModal(modal);
        }

        if (customId === 'action_viewmenu') {
            const ud = getUser(user.id);
            const menu = ud.shopMenu || [];
            const embed = new EmbedBuilder().setColor(0xff9900).setTitle(`📋 เมนูร้าน ${ud.shop}`).setTimestamp();
            if (!menu.length) embed.setDescription('ยังไม่มีสินค้า');
            else menu.forEach((item, i) => { const s = item.stock == null ? '♾️' : item.stock > 0 ? `📦${item.stock}` : '❌หมด'; embed.addFields({ name: `${i + 1}. ${item.name}`, value: `💵 ${item.price.toLocaleString()} บาท | ${s}${item.description ? `\n${item.description}` : ''}`, inline: true }); });
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('panel_menu').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary));
            return interaction.update({ embeds: [embed], components: [row] });
        }

        if (customId === 'action_restock') {
            const modal = new ModalBuilder().setCustomId('modal_restock').setTitle('📦 เติมสต็อก');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_name').setLabel('ชื่อสินค้า').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('จำนวนที่จะเติม').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 20')),
            );
            return interaction.showModal(modal);
        }

        if (customId === 'action_hire') {
            const modal = new ModalBuilder().setCustomId('modal_hire').setTitle('➕ เสนองาน');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('char_name').setLabel('ชื่อบัญชีผู้รับ (charName)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น นายโปรแกรมเมอร์')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role').setLabel('ตำแหน่ง').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('เช่น พ่อครัว, แคชเชียร์')),
            );
            return interaction.showModal(modal);
        }

        if (customId === 'action_fire') {
            const modal = new ModalBuilder().setCustomId('modal_fire').setTitle('❌ ไล่พนักงานออก');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('char_name').setLabel('ชื่อบัญชีพนักงานที่จะไล่ออก (charName)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น นายโปรแกรมเมอร์')));
            return interaction.showModal(modal);
        }

        // ── Job offer responses (มาจาก DM) ──────────────────────────────────
        if (customId.startsWith('job_accept:') || customId.startsWith('job_decline:')) {
            const offerId   = customId.split(':')[1];
            const offer     = pendingJobOffers.get(offerId);
            const isAccept  = customId.startsWith('job_accept:');

            if (!offer) {
                return interaction.update({
                    embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('⏰ คำเชิญหมดอายุแล้ว').setDescription('บอทรีสตาร์ทไปแล้ว คำเชิญนี้ใช้ไม่ได้อีกต่อไป')],
                    components: [],
                });
            }

            // ต้องเป็นคนที่รับ offer เท่านั้น
            if (user.id !== offer.targetId) {
                return interaction.reply({ content: '❌ คำเชิญนี้ไม่ได้มาถึงคุณ!', ephemeral: true });
            }

            pendingJobOffers.delete(offerId);

            if (!isAccept) {
                // ── ปฏิเสธ ──
                addInbox(offer.ownerId, '❌', `**${getUser(offer.targetId).charName || 'ไม่ทราบ'}** ปฏิเสธตำแหน่ง **${offer.role}** ที่ร้าน **${offer.shopName}**`);
                await interaction.update({
                    embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ ปฏิเสธงานแล้ว').setDescription(`คุณปฏิเสธตำแหน่ง **${offer.role}** ที่ร้าน **${offer.shopName}**`)],
                    components: [],
                });
                try {
                    const owner = await client.users.fetch(offer.ownerId);
                    await owner.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ คำเชิญถูกปฏิเสธ').setDescription(`<@${offer.targetId}> ปฏิเสธตำแหน่ง **${offer.role}** ที่ร้าน **${offer.shopName}**`).setTimestamp()] });
                } catch {}
                return;
            }

            // ── รับงาน ──
            const ownerData = getUser(offer.ownerId);
            const targetData = getUser(offer.targetId);
            const staff = ownerData.shopStaff || [];

            if (staff.find(s => s.id === offer.targetId)) {
                return interaction.update({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('❌ คุณเป็นพนักงานอยู่แล้ว').setDescription('มีคนอื่นเพิ่งรับคุณเข้ามาแล้ว')], components: [] });
            }

            staff.push({ id: offer.targetId, name: targetData.charName || user.username, role: offer.role, hiredAt: Date.now() });
            updateUser(offer.ownerId, { shopStaff: staff });

            // เปิดสิทธิ์ห้องครัว
            if (ownerData.kitchenChannelId) {
                try {
                    const kitchen = await client.channels.fetch(ownerData.kitchenChannelId);
                    await kitchen.permissionOverwrites.edit(offer.targetId, { [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ReadMessageHistory]: true });
                    await kitchen.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setDescription(`👋 ยินดีต้อนรับ <@${offer.targetId}> ในฐานะ **${offer.role}**!`).setTimestamp()] });
                } catch {}
            }

            await interaction.update({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ รับงานสำเร็จ!').setDescription(`คุณได้เป็นพนักงานร้าน **${offer.shopName}** แล้ว 🎉`).addFields({ name: '👔 ตำแหน่ง', value: offer.role, inline: true }).setTimestamp()],
                components: [],
            });

            // inbox: ผู้รับงาน
            addInbox(offer.targetId, '✅', `รับตำแหน่ง **${offer.role}** ที่ร้าน **${offer.shopName}** แล้ว`);
            // inbox + DM: เจ้าของร้าน
            addInbox(offer.ownerId, '🎉', `**${targetData.charName || 'ไม่ทราบ'}** รับตำแหน่ง **${offer.role}** ที่ร้านของคุณแล้ว`);
            try {
                const owner = await client.users.fetch(offer.ownerId);
                await owner.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🎉 มีพนักงานใหม่!').setDescription(`<@${offer.targetId}> รับตำแหน่ง **${offer.role}** ที่ร้าน **${offer.shopName}** แล้ว`).addFields({ name: '👥 พนักงานรวม', value: `${staff.length} คน`, inline: true }).setTimestamp()] });
            } catch {}
            return;
        }

        if (customId === 'action_newhome') {
            const modal = new ModalBuilder().setCustomId('modal_newhome').setTitle('🏗️ ซื้อบ้าน (1,000 บาท)');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('home_name').setLabel('ชื่อบ้าน').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30).setPlaceholder('เช่น บ้านริมทะเล')));
            return interaction.showModal(modal);
        }

        if (customId === 'action_invite') {
            const modal = new ModalBuilder().setCustomId('modal_invite').setTitle('🤝 เชิญเพื่อนเข้าบ้าน');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('Discord ID ของเพื่อน').setStyle(TextInputStyle.Short).setRequired(true)));
            return interaction.showModal(modal);
        }

        if (customId === 'action_uninvite') {
            const modal = new ModalBuilder().setCustomId('modal_uninvite').setTitle('🚪 เตะออกจากบ้าน');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user_id').setLabel('Discord ID ที่จะเตะออก').setStyle(TextInputStyle.Short).setRequired(true)));
            return interaction.showModal(modal);
        }

        if (customId === 'action_stock_buy') {
            const ud = getUser(user.id);
            const modal = new ModalBuilder().setCustomId('modal_stock_buy').setTitle('📈 ซื้อหุ้น');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('symbol').setLabel('ชื่อย่อหุ้น').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('SKBD / BREAD / GOLD / DBANK / FARM / TECH')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('จำนวนหุ้น').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 10')),
            );
            addPinFieldIfNeeded(modal, ud);
            return interaction.showModal(modal);
        }

        if (customId === 'action_stock_sell') {
            const ud = getUser(user.id);
            const modal = new ModalBuilder().setCustomId('modal_stock_sell').setTitle('📉 ขายหุ้น');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('symbol').setLabel('ชื่อย่อหุ้น').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('SKBD / BREAD / GOLD / DBANK / FARM / TECH')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('จำนวนหุ้น').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('เช่น 10')),
            );
            addPinFieldIfNeeded(modal, ud);
            return interaction.showModal(modal);
        }

        if (customId === 'action_stock_portfolio') {
            const ud = getUser(user.id); const stocks = loadStocks(); const port = ud.portfolio || {};
            const keys = Object.keys(port).filter(k => port[k].amount > 0);
            if (!keys.length) { await interaction.reply({ content: '📭 ยังไม่มีหุ้น', ephemeral: true }); return; }
            let tv = 0, tc = 0;
            const lines = keys.map(sym => { const s = stocks[sym]; const p = port[sym]; const v = s.price * p.amount; const c = p.avgCost * p.amount; const pl = v - c; tv += v; tc += c; return `${s.emoji} **${sym}** x${p.amount} | ${v.toLocaleString()} | ${pl >= 0 ? '📈+' : '📉'}${pl.toLocaleString()}`; });
            const tpl = tv - tc;
            const embed = new EmbedBuilder().setColor(tpl >= 0 ? 0x57f287 : 0xed4245).setTitle(`📊 พอร์ตของ ${ud.charName}`).setDescription(lines.join('\n')).addFields({ name: '💎 รวม', value: `${tv.toLocaleString()} บาท`, inline: true }, { name: tpl >= 0 ? '📈 กำไร' : '📉 ขาดทุน', value: `${tpl >= 0 ? '+' : ''}${tpl.toLocaleString()} บาท`, inline: true }).setTimestamp();
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('panel_stock').setLabel('↩ กลับ').setStyle(ButtonStyle.Secondary));
            return interaction.update({ embeds: [embed], components: [row] });
        }

        if (customId === 'action_qr_generate') {
            await interaction.deferReply({ ephemeral: true });
            const ud = getUser(user.id);
            const qrPath = `./qr_${user.id}.png`;
            await QRCode.toFile(qrPath, JSON.stringify({ userId: user.id, username: ud.charName || user.username, type: 'payment' }), { width: 300, margin: 2 });
            const att = new AttachmentBuilder(qrPath, { name: 'qrcode.png' });
            await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x0099ff).setTitle('📲 QR Code ของคุณ').setDescription('ให้คนอื่นสแกนเพื่อโอนเงินให้คุณ').addFields({ name: '💵 ยอดเงิน', value: `${ud.balance.toLocaleString()} บาท`, inline: true }).setImage('attachment://qrcode.png').setTimestamp()], files: [att] });
            setTimeout(() => { try { fs.unlinkSync(qrPath); } catch {} }, 10000);
            return;
        }

        // ── Settings actions ──────────────────────────────────────────────────
        if (customId === 'action_set_pin') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            const modal = new ModalBuilder().setCustomId('modal_set_pin').setTitle('🔢 ตั้ง PIN');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pin').setLabel('PIN ใหม่ (4–6 ตัวเลข)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(6).setPlaceholder('เช่น 1234')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('confirm_pin').setLabel('ยืนยัน PIN อีกครั้ง').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(6).setPlaceholder('กรอก PIN เดิมซ้ำ')),
            );
            if (ud.pinHash) {
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('old_pin').setLabel('PIN เดิม (ใส่เพื่อยืนยัน)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(6).setPlaceholder('PIN ปัจจุบันของคุณ')));
            }
            return interaction.showModal(modal);
        }

        if (customId === 'action_set_bio') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            const modal = new ModalBuilder().setCustomId('modal_set_bio').setTitle('📝 ตั้ง Bio');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bio').setLabel('Bio ของคุณ').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(150).setPlaceholder('แนะนำตัวเอง, อาชีพ, หรืออะไรก็ได้...\n(เว้นว่างเพื่อล้าง Bio)').setValue(ud.bio || '')),
            );
            return interaction.showModal(modal);
        }

        if (customId === 'action_set_embed') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            const currentHex = ud.embedColor ? `#${ud.embedColor.toString(16).padStart(6, '0').toUpperCase()}` : '';
            const modal = new ModalBuilder().setCustomId('modal_set_embed').setTitle('🎨 ตั้งสี Embed');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('สี Hex (เช่น #FF5733 หรือ FF5733)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7).setPlaceholder('เว้นว่างเพื่อใช้สีเริ่มต้น').setValue(currentHex)),
            );
            return interaction.showModal(modal);
        }

        if (customId === 'action_toggle_session') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            const newVal = !ud.noSessionTimeout;
            updateUser(user.id, { noSessionTimeout: newVal });
            return interaction.update(buildSettingsPanel(user.id));
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MODAL SUBMISSIONS
    // ══════════════════════════════════════════════════════════════════════════

    if (interaction.isModalSubmit()) {
        const { customId, user } = interaction;

        // ── Register (สมัครสมาชิกครั้งแรก) ──────────────────────────────────────
        if (customId === 'modal_register') {
            const ud = getUser(user.id);
            if (ud.loggedIn) return interaction.reply({ content: '❌ คุณมีบัญชีแล้ว! ใช้ปุ่ม **🔐 เข้าสู่ระบบ** แทน', ephemeral: true });
            const charName = interaction.fields.getTextInputValue('charname').trim();
            const jobKey = interaction.fields.getTextInputValue('job').trim().toLowerCase();
            const password = interaction.fields.getTextInputValue('password');
            if (!JOBS[jobKey]) return interaction.reply({ content: `❌ อาชีพ "${jobKey}" ไม่ถูกต้อง!\nใช้: chef, builder, driver, programmer, delivery, farmer, trader, doctor`, ephemeral: true });
            const job = JOBS[jobKey];
            updateUser(user.id, { loggedIn: true, balance: job.start, charName, jobKey, passwordHash: hashPassword(password) });
            activeSessions.set(user.id, Date.now());
            await trySetNickname(interaction, charName);
            await interaction.reply({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🎉 สมัครสมาชิกสำเร็จ!')
                    .setThumbnail(user.displayAvatarURL({ size: 256 }))
                    .setDescription(`ยินดีต้อนรับ **${charName}**! 🌏\n✅ เข้าสู่ระบบแล้วอัตโนมัติ`)
                    .addFields(
                        { name: `${job.emoji} อาชีพ`, value: job.name, inline: true },
                        { name: '💵 รายได้/ครั้ง', value: `${job.min}–${job.max} บาท`, inline: true },
                        { name: '💰 เงินตั้งต้น', value: `${job.start} บาท`, inline: true },
                        { name: '🔐 รหัสผ่าน', value: 'บันทึกแล้ว — ใช้เข้าสู่ระบบครั้งต่อไป', inline: false },
                    )
                    .setFooter({ text: 'Session หมดเมื่อบอทรีสตาร์ท — login ใหม่ได้ที่ /panel' })
                    .setTimestamp()],
                ephemeral: true,
            });
            return;
        }

        // ── Login (กรอกรหัสผ่าน) ──────────────────────────────────────────────
        if (customId === 'modal_login') {
            const ud = getUser(user.id);
            if (!ud.loggedIn) return interaction.reply({ content: '❌ ยังไม่มีบัญชี! กด **📝 สมัครสมาชิก** ก่อน', ephemeral: true });
            if (isSessionActive(user.id)) return interaction.reply({ content: '✅ เข้าสู่ระบบอยู่แล้ว!', ephemeral: true });

            const password = interaction.fields.getTextInputValue('password');
            if (!ud.passwordHash) {
                // บัญชีเก่าที่ยังไม่มีรหัส — ตั้งรหัสใหม่ได้เลย
                updateUser(user.id, { passwordHash: hashPassword(password) });
                activeSessions.set(user.id, Date.now());
                await trySetNickname(interaction, ud.charName);
                return interaction.reply({
                    embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🔐 ตั้งรหัสผ่านและเข้าสู่ระบบสำเร็จ!')
                        .setDescription(`ยินดีต้อนรับกลับ **${ud.charName}**!\nรหัสผ่านถูกตั้งค่าเรียบร้อยแล้ว`)
                        .setTimestamp()],
                    ephemeral: true,
                });
            }

            if (hashPassword(password) !== ud.passwordHash) {
                return interaction.reply({ content: '❌ รหัสผ่านไม่ถูกต้อง! ลองใหม่อีกครั้ง', ephemeral: true });
            }

            activeSessions.set(user.id, Date.now());
            await trySetNickname(interaction, ud.charName);
            const job = JOBS[ud.jobKey];
            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ เข้าสู่ระบบสำเร็จ!')
                    .setThumbnail(user.displayAvatarURL({ size: 128 }))
                    .setDescription(`ยินดีต้อนรับกลับ **${ud.charName}**! 👋`)
                    .addFields(
                        { name: `${job ? job.emoji : '💼'} อาชีพ`, value: job ? job.name : '-', inline: true },
                        { name: '💵 กระเป๋า', value: `${ud.balance.toLocaleString()} บาท`, inline: true },
                        { name: '🏦 ธนาคาร', value: `${ud.deposited.toLocaleString()} บาท`, inline: true },
                    )
                    .setFooter({ text: 'Session จะหมดเมื่อบอทรีสตาร์ท' })
                    .setTimestamp()],
                ephemeral: true,
            });
        }

        // ── Finance ───────────────────────────────────────────────────────────
        if (customId === 'modal_deposit') {
            const ud = getUser(user.id);
            if (!checkPIN(interaction, ud)) return;
            const amount = parseInt(interaction.fields.getTextInputValue('amount'));
            if (isNaN(amount) || amount < 1) return interaction.reply({ content: '❌ จำนวนไม่ถูกต้อง!', ephemeral: true });
            if (ud.balance < amount) return interaction.reply({ content: `❌ เงินไม่พอ! มีแค่ ${ud.balance.toLocaleString()} บาท`, ephemeral: true });
            updateUser(user.id, { balance: ud.balance - amount, deposited: ud.deposited + amount });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x0099ff).setTitle('🏦 ฝากเงินสำเร็จ!').addFields({ name: '💵 ฝาก', value: `${amount.toLocaleString()} บาท`, inline: true }, { name: '🏦 ธนาคาร', value: `${(ud.deposited + amount).toLocaleString()} บาท`, inline: true }, { name: '💰 กระเป๋า', value: `${(ud.balance - amount).toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildFinancePanel(user.id));
        }

        if (customId === 'modal_withdraw') {
            const ud = getUser(user.id);
            if (!checkPIN(interaction, ud)) return;
            const amount = parseInt(interaction.fields.getTextInputValue('amount'));
            if (isNaN(amount) || amount < 1) return interaction.reply({ content: '❌ จำนวนไม่ถูกต้อง!', ephemeral: true });
            if (ud.deposited < amount) return interaction.reply({ content: `❌ เงินในธนาคารไม่พอ! มีแค่ ${ud.deposited.toLocaleString()} บาท`, ephemeral: true });
            updateUser(user.id, { balance: ud.balance + amount, deposited: ud.deposited - amount });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('💰 ถอนเงินสำเร็จ!').addFields({ name: '💸 ถอน', value: `${amount.toLocaleString()} บาท`, inline: true }, { name: '💵 กระเป๋า', value: `${(ud.balance + amount).toLocaleString()} บาท`, inline: true }, { name: '🏦 ธนาคาร', value: `${(ud.deposited - amount).toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildFinancePanel(user.id));
        }

        if (customId === 'modal_give') {
            const ud = getUser(user.id);
            if (!checkPIN(interaction, ud)) return;
            const receiverId = interaction.fields.getTextInputValue('user_id').trim();
            const amount = parseInt(interaction.fields.getTextInputValue('amount'));
            if (isNaN(amount) || amount < 1) return interaction.reply({ content: '❌ จำนวนไม่ถูกต้อง!', ephemeral: true });
            if (receiverId === user.id) return interaction.reply({ content: '❌ ไม่สามารถโอนให้ตัวเองได้!', ephemeral: true });
            const receiver = getUser(receiverId);
            if (!receiver.loggedIn) return interaction.reply({ content: '❌ ผู้รับยังไม่ได้เข้าสู่ระบบ!', ephemeral: true });
            if (ud.balance < amount) return interaction.reply({ content: `❌ เงินไม่พอ! มีแค่ ${ud.balance.toLocaleString()} บาท`, ephemeral: true });
            updateUser(user.id, { balance: ud.balance - amount }); updateUser(receiverId, { balance: receiver.balance + amount });
            addInbox(receiverId, '💸', `ได้รับโอนเงิน **${amount.toLocaleString()} บาท** จาก **${ud.charName || 'ไม่ทราบ'}**`);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('💸 โอนเงินสำเร็จ!').addFields({ name: '📥 ผู้รับ', value: receiver.charName || receiverId, inline: true }, { name: '💵 จำนวน', value: `${amount.toLocaleString()} บาท`, inline: true }, { name: '💰 เงินคงเหลือ', value: `${(ud.balance - amount).toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildFinancePanel(user.id));
        }

        // ── Shop ──────────────────────────────────────────────────────────────
        if (customId === 'modal_newshop') {
            const name = interaction.fields.getTextInputValue('shop_name').trim();
            await handleNewShop(interaction, name);
            return;
        }

        // ── Menu ──────────────────────────────────────────────────────────────
        if (customId === 'modal_addmenu') {
            const ud = getUser(user.id);
            if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
            const itemName = interaction.fields.getTextInputValue('item_name').trim();
            const priceStr = interaction.fields.getTextInputValue('item_price').trim();
            const desc = interaction.fields.getTextInputValue('item_desc').trim();
            const stockStr = interaction.fields.getTextInputValue('item_stock').trim();
            const price = parseInt(priceStr);
            if (isNaN(price) || price < 1) return interaction.reply({ content: '❌ ราคาไม่ถูกต้อง!', ephemeral: true });
            const stock = stockStr ? parseInt(stockStr) : null;
            if (stockStr && (isNaN(stock) || stock < 1)) return interaction.reply({ content: '❌ สต็อกไม่ถูกต้อง!', ephemeral: true });
            const menu = ud.shopMenu || [];
            if (menu.length >= 20) return interaction.reply({ content: '❌ เมนูเต็ม!', ephemeral: true });
            if (menu.find(m => m.name.toLowerCase() === itemName.toLowerCase())) return interaction.reply({ content: `❌ มี **${itemName}** อยู่แล้ว!`, ephemeral: true });
            menu.push({ name: itemName, price, description: desc, stock });
            updateUser(user.id, { shopMenu: menu });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ เพิ่มสินค้าสำเร็จ!').addFields({ name: '🛒 ชื่อ', value: itemName, inline: true }, { name: '💵 ราคา', value: `${price.toLocaleString()} บาท`, inline: true }, { name: '📦 สต็อก', value: stock != null ? `${stock} ชิ้น` : '♾️ ไม่จำกัด', inline: true }, { name: '📝 รายละเอียด', value: desc || '(ไม่มี)', inline: false }, { name: '📋 เมนูรวม', value: `${menu.length}/20`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildMenuPanel(user.id));
        }

        if (customId === 'modal_removemenu') {
            const ud = getUser(user.id);
            const itemName = interaction.fields.getTextInputValue('item_name').trim();
            const menu = ud.shopMenu || [];
            const idx = menu.findIndex(m => m.name.toLowerCase() === itemName.toLowerCase());
            if (idx === -1) return interaction.reply({ content: `❌ ไม่พบ **${itemName}**`, ephemeral: true });
            const removed = menu.splice(idx, 1)[0];
            updateUser(user.id, { shopMenu: menu });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff6600).setTitle('🗑️ ลบสินค้าสำเร็จ!').addFields({ name: '🛒 ลบแล้ว', value: removed.name, inline: true }, { name: '💵 ราคาเดิม', value: `${removed.price.toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildMenuPanel(user.id));
        }

        if (customId === 'modal_restock') {
            const ud = getUser(user.id);
            const itemName = interaction.fields.getTextInputValue('item_name').trim();
            const qty = parseInt(interaction.fields.getTextInputValue('quantity'));
            if (isNaN(qty) || qty < 1) return interaction.reply({ content: '❌ จำนวนไม่ถูกต้อง!', ephemeral: true });
            const menu = ud.shopMenu || [];
            const item = menu.find(m => m.name.toLowerCase() === itemName.toLowerCase());
            if (!item) return interaction.reply({ content: `❌ ไม่พบ **${itemName}**`, ephemeral: true });
            if (item.stock == null) return interaction.reply({ content: '❌ สินค้านี้ไม่จำกัดสต็อก ไม่ต้องเติม!', ephemeral: true });
            const before = item.stock; item.stock += qty;
            updateUser(user.id, { shopMenu: menu });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('📦 เติมสต็อกสำเร็จ!').addFields({ name: '🛒 สินค้า', value: item.name, inline: true }, { name: '➕ เพิ่ม', value: `${qty}`, inline: true }, { name: '📦 รวม', value: `${before} → **${item.stock}**`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildInventoryPanel(user.id));
        }

        // ── Staff ─────────────────────────────────────────────────────────────
        if (customId === 'modal_hire') {
            const charName = interaction.fields.getTextInputValue('char_name').trim();
            const role = interaction.fields.getTextInputValue('role').trim() || 'พนักงาน';
            const targetId = findUserIdByCharName(charName);
            if (!targetId) return interaction.reply({ content: `❌ ไม่พบบัญชีชื่อ **${charName}**\nตรวจสอบชื่อให้ถูกต้อง (ต้องตรงทุกตัวอักษร)`, ephemeral: true });
            try {
                const targetUser = await client.users.fetch(targetId);
                await handleHire(interaction, targetUser, role);
            } catch { return interaction.reply({ content: '❌ เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้!', ephemeral: true }); }
            return;
        }

        if (customId === 'modal_fire') {
            const charName = interaction.fields.getTextInputValue('char_name').trim();
            const ud = getUser(user.id);
            const staff = ud.shopStaff || [];
            const member = staff.find(s => s.name && s.name.toLowerCase() === charName.toLowerCase());
            if (!member) return interaction.reply({ content: `❌ ไม่พบพนักงานชื่อ **${charName}** ในร้านของคุณ`, ephemeral: true });
            try {
                const targetUser = await client.users.fetch(member.id);
                await handleFire(interaction, targetUser);
            } catch { return interaction.reply({ content: '❌ เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้!', ephemeral: true }); }
            return;
        }

        // ── Home ──────────────────────────────────────────────────────────────
        if (customId === 'modal_newhome') {
            const name = interaction.fields.getTextInputValue('home_name').trim();
            await handleNewHome(interaction, name);
            return;
        }

        if (customId === 'modal_invite') {
            const ud = getUser(user.id);
            const targetId = interaction.fields.getTextInputValue('user_id').trim();
            if (!ud.homeChannelId) return interaction.reply({ content: '❌ ยังไม่มีบ้าน!', ephemeral: true });
            try {
                const ch = await client.channels.fetch(ud.homeChannelId);
                await ch.permissionOverwrites.edit(targetId, { [PermissionFlagsBits.ViewChannel]: true, [PermissionFlagsBits.SendMessages]: true, [PermissionFlagsBits.ReadMessageHistory]: true });
                await ch.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setDescription(`🏠 ยินดีต้อนรับ <@${targetId}>!`)] });
                return interaction.reply({ content: '✅ เชิญสำเร็จ!', ephemeral: true });
            } catch { return interaction.reply({ content: '❌ เกิดข้อผิดพลาด', ephemeral: true }); }
        }

        if (customId === 'modal_uninvite') {
            const ud = getUser(user.id);
            const targetId = interaction.fields.getTextInputValue('user_id').trim();
            if (!ud.homeChannelId) return interaction.reply({ content: '❌ ยังไม่มีบ้าน!', ephemeral: true });
            try {
                const ch = await client.channels.fetch(ud.homeChannelId);
                await ch.permissionOverwrites.edit(targetId, { [PermissionFlagsBits.ViewChannel]: false, [PermissionFlagsBits.SendMessages]: false });
                return interaction.reply({ content: '✅ เตะออกสำเร็จ!', ephemeral: true });
            } catch { return interaction.reply({ content: '❌ เกิดข้อผิดพลาด', ephemeral: true }); }
        }

        // ── Stock ─────────────────────────────────────────────────────────────
        // ── Lottery buy ────────────────────────────────────────────────────────
        if (customId === 'modal_lottery_buy') {
            if (!requireLogin(interaction)) return;
            const ud = getUser(user.id);
            if (!checkPIN(interaction, ud)) return;
            const numRaw = interaction.fields.getTextInputValue('number').trim();
            const qtyRaw = interaction.fields.getTextInputValue('qty').trim();
            const num = parseInt(numRaw);
            const qty = parseInt(qtyRaw);

            if (isNaN(num) || num < 1 || num > 99)
                return interaction.reply({ content: '❌ เลขต้องอยู่ระหว่าง **1–99** เท่านั้น!', ephemeral: true });
            if (isNaN(qty) || qty < 1 || qty > 10)
                return interaction.reply({ content: '❌ จำนวนใบต้องอยู่ระหว่าง **1–10**!', ephemeral: true });

            const cost = 100 * qty;
            if (ud.balance < cost)
                return interaction.reply({ content: `❌ เงินไม่พอ! ต้องใช้ **${cost.toLocaleString()} บาท** มีแค่ ${ud.balance.toLocaleString()} บาท`, ephemeral: true });

            const lottery = loadLottery();
            for (let i = 0; i < qty; i++) {
                lottery.tickets.push({ userId: user.id, charName: ud.charName, number: num, boughtAt: Date.now() });
            }
            lottery.pool += cost;
            saveLottery(lottery);
            updateUser(user.id, { balance: ud.balance - cost });

            const ms = msTillMidnightBKK();
            const hours = Math.floor(ms / 3600_000);
            const mins  = Math.floor((ms % 3600_000) / 60_000);

            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(0xffd700).setTitle('🎟️ ซื้อสลากสำเร็จ!')
                    .setDescription(`เลือกเลข **${num}** จำนวน **${qty} ใบ**`)
                    .addFields(
                        { name: '💸 จ่ายไป', value: `${cost.toLocaleString()} บาท`, inline: true },
                        { name: '💵 กระเป๋าคงเหลือ', value: `${(ud.balance - cost).toLocaleString()} บาท`, inline: true },
                        { name: '💰 พูลรวมตอนนี้', value: `${lottery.pool.toLocaleString()} บาท`, inline: true },
                        { name: '⏰ ออกรางวัลใน', value: `${hours} ชม. ${mins} นาที`, inline: true },
                    )
                    .setFooter({ text: 'ขอให้โชคดี! 🍀 ผู้ชนะรับ 70% ของพูล' })
                    .setTimestamp()],
                ephemeral: true,
            });
        }

        // ── Settings modals ───────────────────────────────────────────────────
        if (customId === 'modal_set_pin') {
            const ud = getUser(user.id);
            const newPin     = interaction.fields.getTextInputValue('pin').trim();
            const confirmPin = interaction.fields.getTextInputValue('confirm_pin').trim();
            if (!/^\d{4,6}$/.test(newPin))
                return interaction.reply({ content: '❌ PIN ต้องเป็นตัวเลข 4–6 หลักเท่านั้น!', ephemeral: true });
            if (newPin !== confirmPin)
                return interaction.reply({ content: '❌ PIN ทั้งสองช่องไม่ตรงกัน! ลองอีกครั้ง', ephemeral: true });
            if (ud.pinHash) {
                const oldPin = interaction.fields.getTextInputValue('old_pin').trim();
                if (hashPassword(oldPin) !== ud.pinHash)
                    return interaction.reply({ content: '❌ PIN เดิมไม่ถูกต้อง!', ephemeral: true });
            }
            updateUser(user.id, { pinHash: hashPassword(newPin) });
            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🔢 ตั้ง PIN สำเร็จ!')
                    .setDescription('PIN ของคุณถูกบันทึกเรียบร้อยแล้ว\nใช้ยืนยันธุรกรรมสำคัญในอนาคต')
                    .setTimestamp()],
                ephemeral: true,
            });
        }

        if (customId === 'modal_set_bio') {
            const bio = interaction.fields.getTextInputValue('bio').trim();
            updateUser(user.id, { bio: bio || null });
            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle(bio ? '📝 ตั้ง Bio สำเร็จ!' : '📝 ล้าง Bio สำเร็จ!')
                    .setDescription(bio ? `Bio ใหม่: "${bio}"` : 'Bio ของคุณถูกล้างแล้ว')
                    .setTimestamp()],
                ephemeral: true,
            });
        }

        if (customId === 'modal_set_embed') {
            const raw = interaction.fields.getTextInputValue('color').trim().replace(/^#/, '');
            if (raw === '') {
                updateUser(user.id, { embedColor: null });
                return interaction.reply({ content: '🎨 รีเซ็ตสี Embed เป็นค่าเริ่มต้นแล้ว', ephemeral: true });
            }
            if (!/^[0-9a-fA-F]{6}$/.test(raw))
                return interaction.reply({ content: '❌ สี Hex ไม่ถูกต้อง!\nใส่แบบ `FF5733` หรือ `#FF5733` (6 หลัก HEX)', ephemeral: true });
            const colorNum = parseInt(raw, 16);
            updateUser(user.id, { embedColor: colorNum });
            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(colorNum).setTitle('🎨 ตั้งสี Embed สำเร็จ!')
                    .setDescription(`สีใหม่: **#${raw.toUpperCase()}**\nEmbed ทั้งหมดของคุณจะใช้สีนี้`)
                    .setTimestamp()],
                ephemeral: true,
            });
        }

        if (customId === 'modal_stock_buy') {
            const ud = getUser(user.id); const stocks = loadStocks();
            if (!checkPIN(interaction, ud)) return;
            const sym = interaction.fields.getTextInputValue('symbol').trim().toUpperCase();
            const amt = parseInt(interaction.fields.getTextInputValue('amount'));
            if (!stocks[sym]) return interaction.reply({ content: `❌ ไม่พบหุ้น **${sym}**\nใช้: SKBD, BREAD, GOLD, DBANK, FARM, TECH`, ephemeral: true });
            if (isNaN(amt) || amt < 1) return interaction.reply({ content: '❌ จำนวนไม่ถูกต้อง!', ephemeral: true });
            const s = stocks[sym]; const cost = s.price * amt;
            if (ud.balance < cost) return interaction.reply({ content: `❌ เงินไม่พอ! ต้องใช้ ${cost.toLocaleString()} บาท มีแค่ ${ud.balance.toLocaleString()}`, ephemeral: true });
            const port = ud.portfolio || {};
            if (!port[sym]) port[sym] = { amount: 0, avgCost: 0 };
            port[sym].avgCost = Math.round(((port[sym].avgCost * port[sym].amount) + cost) / (port[sym].amount + amt));
            port[sym].amount += amt;
            updateUser(user.id, { balance: ud.balance - cost, portfolio: port });
            stocks[sym].volume += amt; saveStocks(stocks);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ ซื้อหุ้นสำเร็จ!').addFields({ name: `${s.emoji} ${sym}`, value: `x${amt}`, inline: true }, { name: '🧾 ยอด', value: `${cost.toLocaleString()} บาท`, inline: true }, { name: '💵 เงินคงเหลือ', value: `${(ud.balance - cost).toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildStockPanel(user.id));
        }

        if (customId === 'modal_stock_sell') {
            const ud = getUser(user.id); const stocks = loadStocks();
            if (!checkPIN(interaction, ud)) return;
            const sym = interaction.fields.getTextInputValue('symbol').trim().toUpperCase();
            const amt = parseInt(interaction.fields.getTextInputValue('amount'));
            if (!stocks[sym]) return interaction.reply({ content: `❌ ไม่พบหุ้น **${sym}**`, ephemeral: true });
            if (isNaN(amt) || amt < 1) return interaction.reply({ content: '❌ จำนวนไม่ถูกต้อง!', ephemeral: true });
            const port = ud.portfolio || {};
            if (!port[sym] || port[sym].amount < amt) return interaction.reply({ content: `❌ หุ้นไม่พอ! มีแค่ ${port[sym]?.amount || 0}`, ephemeral: true });
            const s = stocks[sym]; const earned = s.price * amt; const pl = (s.price - port[sym].avgCost) * amt;
            port[sym].amount -= amt; if (!port[sym].amount) delete port[sym];
            updateUser(user.id, { balance: ud.balance + earned, portfolio: port });
            stocks[sym].volume += amt; saveStocks(stocks);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(pl >= 0 ? 0x57f287 : 0xed4245).setTitle(pl >= 0 ? '💹 ขายกำไร!' : '📉 ขายขาดทุน').addFields({ name: '🧾 ยอดรับ', value: `${earned.toLocaleString()} บาท`, inline: true }, { name: pl >= 0 ? '📈 กำไร' : '📉 ขาดทุน', value: `${pl >= 0 ? '+' : ''}${pl.toLocaleString()} บาท`, inline: true }, { name: '💵 เงินใหม่', value: `${(ud.balance + earned).toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });
            return interaction.message.edit(buildStockPanel(user.id));
        }
    }
});

// ════════════════════════════════════════════════════════════════════════════════
// SHARED LOGIC FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════════

async function handleNewShop(interaction, name) {
    const user = interaction.user;
    const ud = getUser(user.id);
    const SHOP_COST = 500;

    if (ud.shop) return interaction.reply({ content: `❌ คุณมีร้านอยู่แล้ว: **${ud.shop}**`, ephemeral: true });
    if (ud.balance < SHOP_COST) return interaction.reply({ content: `❌ เงินไม่พอ! ต้องใช้ ${SHOP_COST} บาท`, ephemeral: true });

    updateUser(user.id, { shop: name, shopOpen: false, balance: ud.balance - SHOP_COST, shopStaff: [] });

    let mentions = '';
    let shopChannelId = null, kitchenChannelId = null, recruitChannelId = null;

    try {
        const guild = interaction.guild;
        const category = await getOrCreateCategory(guild, '🏪 ร้านค้า');
        const everyone = guild.roles.everyone;

        const shopCh = await guild.channels.create({ name: sanitizeChannelName(`ร้าน-${name}`), type: ChannelType.GuildText, parent: category.id, permissionOverwrites: [{ id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] });
        shopChannelId = shopCh.id;

        const kitchenCh = await guild.channels.create({ name: sanitizeChannelName(`ครัว-${name}`), type: ChannelType.GuildText, parent: category.id, topic: `🍳 ห้องครัว ${name} — เฉพาะพนักงาน`, permissionOverwrites: [{ id: everyone, deny: [PermissionFlagsBits.ViewChannel] }, { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }] });
        kitchenChannelId = kitchenCh.id;

        const recruitCh = await guild.channels.create({ name: sanitizeChannelName(`รับสมัคร-${name}`), type: ChannelType.GuildText, parent: category.id, topic: `📋 รับสมัครพนักงานร้าน ${name}`, permissionOverwrites: [{ id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] });
        recruitChannelId = recruitCh.id;

        mentions = `\n📢 <#${shopCh.id}> | 🍳 <#${kitchenCh.id}> | 📋 <#${recruitCh.id}>`;

        await shopCh.send({ embeds: [new EmbedBuilder().setColor(0xff9900).setTitle(`🏪 ยินดีต้อนรับสู่ร้าน ${name}!`).setDescription(`เจ้าของ: <@${user.id}>${ud.charName ? ` (${ud.charName})` : ''}\n\n📋 ดูเมนู: \`/menu @เจ้าของ\`\n🛍️ สั่งซื้อ: \`/order @เจ้าของ <สินค้า>\``).setTimestamp()] });
        await kitchenCh.send({ embeds: [new EmbedBuilder().setColor(0xffa500).setTitle(`🍳 ห้องครัว ${name}`).setDescription(`🔒 ช่องสำหรับ <@${user.id}> และพนักงานเท่านั้น\n📦 \`/inventory\` ดูสต็อก | 📦 \`/restock\` เติมของ\n👥 \`/hire @คน\` รับพนักงาน`).setTimestamp()] });
        await recruitCh.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📋 รับสมัครพนักงาน — ${name}`).setDescription('พิมพ์ใบสมัครของคุณในช่องนี้ได้เลย!\n📝 แนะนำตัว | ประสบการณ์ | ตำแหน่งที่ต้องการ').setTimestamp()] });
    } catch (e) { console.error('newshop channels error:', e.message); }

    updateUser(user.id, { shopChannelId, kitchenChannelId, recruitChannelId });

    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff9900).setTitle('🏪 เปิดร้านค้าสำเร็จ!').setDescription(`สร้าง **3 ช่อง** อัตโนมัติ!${mentions}`).addFields({ name: '🏪 ชื่อร้าน', value: name, inline: true }, { name: '💵 ค่าใช้จ่าย', value: `${SHOP_COST} บาท`, inline: true }, { name: '💰 เงินคงเหลือ', value: `${(ud.balance - SHOP_COST).toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });

    if (interaction.message) return interaction.message.edit(buildShopPanel(user.id));
}

async function handleHire(interaction, targetUser, role) {
    const user = interaction.user;
    const ud = getUser(user.id);
    if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });
    if (targetUser.id === user.id) return interaction.reply({ content: '❌ ไม่สามารถเสนองานให้ตัวเองได้!', ephemeral: true });
    if (targetUser.bot) return interaction.reply({ content: '❌ ไม่สามารถเสนองานให้บอทได้!', ephemeral: true });

    const staff = ud.shopStaff || [];
    if (staff.find(s => s.id === targetUser.id))
        return interaction.reply({ content: `❌ **${targetUser.username}** เป็นพนักงานร้านนี้อยู่แล้ว!`, ephemeral: true });

    const offerId = `${user.id}_${targetUser.id}`;
    if (pendingJobOffers.has(offerId))
        return interaction.reply({ content: `⏳ รอ **${targetUser.username}** ตอบรับคำเชิญก่อนหน้าอยู่!`, ephemeral: true });

    // เก็บ offer ไว้ในหน่วยความจำ (หมดเมื่อบอทรีสตาร์ท)
    pendingJobOffers.set(offerId, { ownerId: user.id, targetId: targetUser.id, role, shopName: ud.shop, sentAt: Date.now() });

    // ส่ง DM ถาม
    const offerEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📩 คุณได้รับการเสนองาน!')
        .setDescription(`**${ud.charName || user.username}** ต้องการชวนคุณทำงาน`)
        .addFields(
            { name: '🏪 ร้านค้า', value: ud.shop, inline: true },
            { name: '👔 ตำแหน่ง', value: role, inline: true },
        )
        .setFooter({ text: 'คำเชิญหมดอายุเมื่อบอทรีสตาร์ท' })
        .setTimestamp();

    const offerRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`job_accept:${offerId}`).setLabel('✅ รับงาน').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`job_decline:${offerId}`).setLabel('❌ ปฏิเสธ').setStyle(ButtonStyle.Danger),
    );

    try {
        await targetUser.send({ embeds: [offerEmbed], components: [offerRow] });
    } catch {
        pendingJobOffers.delete(offerId);
        return interaction.reply({ content: `❌ ไม่สามารถส่ง DM ให้ **${targetUser.username}** ได้\nอาจปิด DM ไว้อยู่`, ephemeral: true });
    }

    await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('📨 ส่งคำเชิญแล้ว!')
            .setDescription(`ส่ง DM ไปหา <@${targetUser.id}> เรียบร้อยแล้ว\nรอการตอบรับ...`)
            .addFields(
                { name: '🏪 ร้าน', value: ud.shop, inline: true },
                { name: '👔 ตำแหน่ง', value: role, inline: true },
            )
            .setTimestamp()],
        ephemeral: true,
    });
}

async function handleFire(interaction, targetUser) {
    const user = interaction.user;
    const ud = getUser(user.id);
    if (!ud.shop) return interaction.reply({ content: '❌ ยังไม่มีร้านค้า!', ephemeral: true });

    const staff = ud.shopStaff || [];
    const idx = staff.findIndex(s => s.id === targetUser.id);
    if (idx === -1) return interaction.reply({ content: `❌ **${targetUser.username}** ไม่ได้เป็นพนักงาน!`, ephemeral: true });

    const fired = staff.splice(idx, 1)[0];
    updateUser(user.id, { shopStaff: staff });

    if (ud.kitchenChannelId) {
        try {
            const kitchen = await client.channels.fetch(ud.kitchenChannelId);
            await kitchen.permissionOverwrites.delete(targetUser.id);
            await kitchen.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setDescription(`🚪 <@${targetUser.id}> (${fired.role}) ออกจากร้านแล้ว`).setTimestamp()] });
        } catch {}
    }

    addInbox(targetUser.id, '🚪', `ถูกออกจากงานที่ร้าน **${ud.shop}** (ตำแหน่ง: ${fired.role})`);
    try { await targetUser.send({ embeds: [new EmbedBuilder().setColor(0xff0000).setTitle('📋 แจ้งออกจากงาน').setDescription(`คุณถูกออกจากงานที่ร้าน **${ud.shop}** แล้ว`).setTimestamp()] }); } catch {}

    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff0000).setTitle('🚪 ไล่พนักงานออกสำเร็จ!').addFields({ name: '👤 พนักงานที่ออก', value: `<@${targetUser.id}>`, inline: true }, { name: '👔 ตำแหน่งเดิม', value: fired.role, inline: true }, { name: '👥 คงเหลือ', value: `${staff.length} คน`, inline: true }).setTimestamp()], ephemeral: true });

    if (interaction.message) return interaction.message.edit(buildStaffPanel(user.id));
}

async function handleNewHome(interaction, name) {
    const user = interaction.user;
    const ud = getUser(user.id);
    const HOME_COST = 1000;

    if (ud.home) return interaction.reply({ content: `❌ คุณมีบ้านอยู่แล้ว: **${ud.home}**`, ephemeral: true });
    if (ud.balance < HOME_COST) return interaction.reply({ content: `❌ เงินไม่พอ! ต้องใช้ ${HOME_COST} บาท`, ephemeral: true });

    updateUser(user.id, { home: name, balance: ud.balance - HOME_COST });

    let mention = '';
    try {
        const cat = await getOrCreateCategory(interaction.guild, '🏠 บ้าน');
        const ch = await interaction.guild.channels.create({ name: sanitizeChannelName(`บ้าน-${name}`), type: ChannelType.GuildText, parent: cat.id, permissionOverwrites: [{ id: interaction.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] }, { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] });
        mention = ` | ช่อง <#${ch.id}>`;
        updateUser(user.id, { homeChannelId: ch.id });
        await ch.send({ embeds: [new EmbedBuilder().setColor(0x9933ff).setTitle(`🏠 ยินดีต้อนรับสู่บ้าน ${name}!`).setDescription(`ที่อยู่ส่วนตัวของ <@${user.id}> 🔒`).setTimestamp()] });
    } catch (e) { console.error('home error:', e.message); }

    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9933ff).setTitle('🏠 ซื้อบ้านสำเร็จ!').addFields({ name: '🏠 ชื่อบ้าน', value: `${name}${mention}`, inline: false }, { name: '💵 ราคา', value: `${HOME_COST} บาท`, inline: true }, { name: '💰 เงินคงเหลือ', value: `${(ud.balance - HOME_COST).toLocaleString()} บาท`, inline: true }).setTimestamp()], ephemeral: true });

    if (interaction.message) return interaction.message.edit(buildHomePanel(user.id));
}

async function handleOrder(interaction, targetUser, itemName, qty) {
    const user = interaction.user;
    if (targetUser.id === user.id) return interaction.reply({ content: '❌ ไม่สามารถสั่งจากร้านตัวเองได้!', ephemeral: true });

    const owner = getUser(targetUser.id);
    const buyer = getUser(user.id);

    if (!owner.loggedIn) return interaction.reply({ content: '❌ ผู้ขายยังไม่ได้เข้าสู่ระบบ!', ephemeral: true });
    if (!owner.shop) return interaction.reply({ content: '❌ ผู้ขายยังไม่มีร้านค้า!', ephemeral: true });
    if (!owner.shopOpen) return interaction.reply({ content: `❌ ร้าน **${owner.shop}** ปิดอยู่!`, ephemeral: true });

    const menu = owner.shopMenu || [];
    const item = menu.find(m => m.name.toLowerCase() === itemName.toLowerCase());
    if (!item) { const list = menu.map(m => `• ${m.name}`).join('\n') || '(ว่าง)'; return interaction.reply({ content: `❌ ไม่พบ **${itemName}**\n\n${list}`, ephemeral: true }); }
    if (item.stock != null && item.stock < qty) return interaction.reply({ content: `❌ สต็อกเหลือแค่ **${item.stock} ชิ้น**!`, ephemeral: true });

    const total = item.price * qty;
    if (buyer.balance < total) return interaction.reply({ content: `❌ เงินไม่พอ! ต้องใช้ ${total.toLocaleString()} บาท`, ephemeral: true });

    if (item.stock != null) item.stock -= qty;
    updateUser(targetUser.id, { shopMenu: menu, balance: owner.balance + total });
    updateUser(user.id, { balance: buyer.balance - total });

    const time = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('🛍️ สั่งซื้อสำเร็จ!').setDescription('🧾 ใบเสร็จ').addFields({ name: '🏪 ร้าน', value: owner.shop, inline: true }, { name: '🛒 สินค้า', value: `${item.name} x${qty}`, inline: true }, { name: '🧾 ยอด', value: `**${total.toLocaleString()} บาท**`, inline: true }, { name: '💰 เงินคงเหลือ', value: `${(buyer.balance - total).toLocaleString()} บาท`, inline: true }, { name: '📦 สต็อกคงเหลือ', value: item.stock == null ? '♾️' : `${item.stock}`, inline: true }, { name: '🕐 เวลา', value: time, inline: true }).setTimestamp()] });

    try { const seller = await client.users.fetch(targetUser.id); await seller.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('💰 ออร์เดอร์ใหม่!').addFields({ name: '👤 ลูกค้า', value: buyer.charName || user.username, inline: true }, { name: '🛒 สินค้า', value: `${item.name} x${qty}`, inline: true }, { name: '💵 รับ', value: `+${total.toLocaleString()} บาท`, inline: true }).setTimestamp()] }); } catch {}

    if (owner.kitchenChannelId) { try { const kCh = await client.channels.fetch(owner.kitchenChannelId); await kCh.send({ embeds: [new EmbedBuilder().setColor(0xff9900).setDescription(`🔔 **ออร์เดอร์!** ${item.name} x${qty}\n👤 ${buyer.charName || user.username} | ⏰ ${time}`).setTimestamp()] }); } catch {} }
    if (owner.shopChannelId) { try { const sCh = await client.channels.fetch(owner.shopChannelId); await sCh.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setDescription(`🛍️ <@${user.id}> สั่ง **${item.name}** x${qty} — ${total.toLocaleString()} บาท`).setTimestamp()] }); } catch {} }
}

// ─── Start ────────────────────────────────────────────────────────────────────

if (!TOKEN || !CLIENT_ID) { console.error('❌ กรุณาตั้งค่า TOKEN และ CLIENT_ID!'); process.exit(1); }
client.login(TOKEN);
