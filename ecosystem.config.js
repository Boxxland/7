module.exports = {
    apps: [
        {
            name: 'discord-bot',
            script: 'index.js',
            watch: false,
            autorestart: true,
            restart_delay: 3000,
            max_restarts: 50,
            min_uptime: 5000,
            exp_backoff_restart_delay: 100,
            env: {
                NODE_ENV: 'production',
            },
            error_file: './logs/pm2-error.log',
            out_file: './logs/pm2-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
