# Deploy files

* `ciphertalk.service` — systemd unit (app on 127.0.0.1:8081).
* `nginx-ciphertalk.conf` — TLS reverse proxy on 443, redirects 80/8080.

Full armbian instructions, CA generation and trust install:
[`docs/DEPLOY_ARMBIAN.md`](../docs/DEPLOY_ARMBIAN.md).
