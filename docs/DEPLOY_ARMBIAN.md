# Деплой CipherTalk на armbian

Текущая инсталляция:

| Параметр | Значение |
|---|---|
| Хост | `server2`, 192.168.1.34, aarch64 |
| ОС | Armbian 26.11 / Debian 13 trixie |
| Приложение | `/opt/ciphertalk/ciphertalk` |
| Порт приложения | `127.0.0.1:8081` (только localhost) |
| Публичный HTTPS | `https://192.168.1.34` (443) |
| HTTP | `:80` и `:8080` → 301 на HTTPS |
| Nginx | `/etc/nginx/conf.d/ciphertalk.conf` |
| systemd | `ciphertalk.service` |
| PostgreSQL | локально `127.0.0.1:5432`, БД/роль `ciphertalk` |
| Redis | локально `127.0.0.1:6379` |
| Файлы | `/opt/ciphertalk/uploads` |
| Конфиг | `/opt/ciphertalk/.env` (`640 root:ciphertalk`) |
| CA | `/etc/ciphertalk-tls/ca.crt` |
| deploy-файлы | `/opt/ciphertalk/deploy/` и репозиторий `deploy/` |

## Открыть

```
https://192.168.1.34
```

Сертификат подписан локальным CA. На этом ПК CA уже добавлен в Chrome NSS,
поэтому `https://192.168.1.34` открывается без предупреждения. На других
устройствах скачайте CA:

```
http://192.168.1.34:8080/ca.crt
```

и установите как доверенный корневой сертификат:

* **Chrome/Firefox на Linux:** `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "CipherTalk Local CA" -i ciphertalk-ca.crt`;
* **Android:** Настройки → Безопасность → Шифрование и учётные данные →
  Установить сертификат → Сертификат CA;
* **Windows:** двойной клик по `.crt` → «Установить» → «Доверенные корневые
  центры сертификации»;
* **iOS:** AirDrop/файл → «Установить профиль», затем «О сертификате» →
  «Доверять».

После установки CA перезапустите браузер. Без доверия к CA браузер не даст
микрофон/камеру (secure context), и звонки/запись голоса будут недоступны.

## Управление

```bash
systemctl status ciphertalk
journalctl -u ciphertalk -f
systemctl restart ciphertalk
systemctl stop ciphertalk
```

Nginx:

```bash
nginx -t
systemctl reload nginx
```

Проверка:

```bash
curl -fsS https://192.168.1.34/health/ready
curl -fsS --cacert /etc/ciphertalk-tls/ca.crt https://192.168.1.34/health/ready
```

## Обновление одной командой

```bash
/opt/ciphertalk/update.sh
```

Скрипт:

1. скачивает ветку `dev-rust-v` из GitHub (в `/opt/ciphertalk` или временный clone);
2. синхронизирует новые/изменённые `src web migrations .sqlx deploy`;
3. собирает только изменившееся (`cargo build --release`, инкрементально, offline с fallback online);
4. устанавливает бинарник и systemd-юнит, перезапускает службу;
5. сразу запускает `journalctl -u ciphertalk -f`;
6. проверяет `health/ready` и `NRestarts`; если служба ушла в restart-loop —
   **останавливает её и печатает последние 80 строк журнала с ошибкой**.

Скрипт нужно запускать от root; `.env`, `uploads` и `target` не затрагиваются.
Если скрипт закрыть по Ctrl-C, служба останется запущенной.

## Обновление кода вручную

Локально в `/media/disk_d/CipherTalk`:

```bash
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test --bin ciphertalk
cargo sqlx prepare -- --all-targets   # при изменении SQL
```

Скопировать `src web migrations .sqlx Cargo.toml Cargo.lock` на сервер,
затем собрать на armbian (offline-метаданные уже в `.sqlx`):

```bash
cd /opt/ciphertalk
SQLX_OFFLINE=true CARGO_HOME=/root/.cargo RUSTUP_HOME=/root/.rustup \
  cargo build --release --locked --offline
install -o root -g ciphertalk -m 750 target/release/ciphertalk /opt/ciphertalk/ciphertalk
systemctl restart ciphertalk
```

Сборка ARM64 release занимает около 7 минут (thin LTO).

## Web Push и стикеры

Web Push включается, если задан `VAPID_PRIVATE_KEY` (base64 DER PKCS#8
P-256) и `VAPID_SUBJECT`. Публичный ключ сервер выводит сам и отдаёт через
`/api/push/public-key`. Пример генерации:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out vapid.pem
openssl pkcs8 -topk8 -nocrypt -in vapid.pem -outform DER -out vapid.der
base64 -w0 vapid.der
# полученную строку положить в .env как VAPID_PRIVATE_KEY=
# VAPID_SUBJECT=mailto:admin@example.com
systemctl restart ciphertalk
```

Проверка фонового уведомления после входа в браузере:

```bash
curl -X POST https://192.168.1.34/api/push/test \
  -H "Authorization: Bearer <access_token>"
```

Стикеры конвертируются серверным `ffmpeg`/`ffprobe` в GIF (до 320 px,
видео до 5 секунд). `update.sh` устанавливает ffmpeg автоматически, если его
нет. В Docker-образе ffmpeg уже включён.

## Резервная копия

```bash
runuser -u postgres -- pg_dump -Fc ciphertalk > /root/ciphertalk-$(date +%F).dump
tar -C /opt/ciphertalk -czf /root/ciphertalk-uploads-$(date +%F).tar.gz uploads
```

## Безопасность

* Пароль `root` на сервере слабый — смените его (`passwd`) или перейдите на
  SSH-ключи; для логов уже добавлен отдельный ключ.
* Firewall на armbian выключен. Если сервер не должен быть доступен всей LAN,
  ограничьте 22/80/443/8080 через nftables/ufw.
* HTTPS использует локальный CA; для доступа из интернета нужен нормальный
  домен + Let's Encrypt (или другой публичный CA) и проброс 80/443.
* `.env` содержит пароль БД и `JWT_SECRET`; не публикуйте его.
* Звонки 1:1 используют STUN Google; для сетей со строгим NAT нужен TURN.
* Емкость: 4 ядра / 3.6 ГБ RAM; для десятков одновременных видеозвонков
  потребуется TURN и больше ресурсов.

## Что не входит в текущий MVP

Каналы, боты, истории, секретные чаты, облачные файлы 2 ГБ, поиск по
сообщениям, пересылка, реакции, групповые звонки, Web Push при закрытой
вкладке и E2E-шифрование. Это следующие итерации; архитектура (модульный
монолит + Redis Pub/Sub + SQLx) оставляет для них место.
