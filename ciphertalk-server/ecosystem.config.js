module.exports = {
  apps: [{
    name: 'ciphertalk',
    script: './server.js',
    cwd: '/mnt/data/projects/CipherTalk/ciphertalk-server',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    time: true
  }]
};
