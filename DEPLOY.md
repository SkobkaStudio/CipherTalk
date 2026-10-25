# Деплой CipherTalk на VPS (Ubuntu 22.04)

## 1. Установка зависимостей
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
sudo npm install -g pm2
```

## 2. Клонирование
```bash
cd /opt
sudo git clone <REPO_URL> ciphertalk
cd ciphertalk/ciphertalk-server
npm ci --omit=dev
```

## 3. Настройка .env
Скопируйте .env.example и настройте:
```bash
cp .env.example .env
nano .env
```
Критичные переменные: PORT, DB_FILE, DB_ENCRYPTION, JWT_SECRET (или оставить авто-генерацию), SMS_PROVIDER, CORS_ORIGIN, TRUST_PROXY.

## 4. Запуск через PM2
```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 5. Nginx + Certbot (опционально)
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
# Настройте reverse proxy на 127.0.0.1:3000
sudo certbot --nginx -d yourdomain.com
```

## 6. Cloudflare Tunnel
```bash
cloudflared tunnel --url http://localhost:3000
```
или настройте через cloudflared config.

## 7. Проверка
```bash
curl http://localhost:3000/api/health
pm2 status
pm2 logs ciphertalk
```
