module.exports = {
  apps: [
    {
      name: 'deskpet',
      cwd: '/www/wwwroot/deskpet',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      max_memory_restart: '1024M',
      env: {
        NODE_ENV: 'production',
        DESKPET_PUBLIC_URL: 'https://in.desktoppet.online',
        DESKPET_DATA_DIR: '/www/deskpet-data',
        DESKPET_HTTP_HOST: '127.0.0.1',
        DESKPET_HTTP_PORT: '3100',
        DESKPET_TRUST_PROXY: 'true',
        DESKPET_SIGNING_PRIVATE_KEY: '/www/deskpet-data/signing-private.pem',
        DESKPET_BOOTSTRAP_VERSION: '2.5.4',
        DESKPET_MACOS_BOOTSTRAP_VERSION: '2.2.2'
      }
    }
  ]
};
