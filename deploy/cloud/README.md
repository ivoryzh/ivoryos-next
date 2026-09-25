# Deploying IvoryOS Cloud

Cloud is two processes from one codebase: the **web app** (Next.js) and the **daemon** (owns the
MQTT connection, dispatches tasks, mirrors what devices publish). They must run together; these
are the supported ways to do that.

| Where | How | Who restarts it |
| --- | --- | --- |
| A lab server / VM (recommended) | Docker Compose, below | Docker (`restart: unless-stopped`) |
| A machine without Docker | `npm run build && npm run start:all -- -p 3002` in `cloud_frontend/` | you, or systemd/pm2 running that command |
| Development | `npm run dev:all -- -p 3002` in `cloud_frontend/` (what `.claude/launch.json` runs) | — |

`start:all` / `dev:all` run both processes as one unit: if either stops, both stop, so nothing is
left half-running on old code.

## Docker Compose

From the repository root:

```bash
# first time, and after every update
git pull
docker compose -f deploy/cloud/docker-compose.yml up -d --build
```

That is the whole update procedure: it rebuilds the image and replaces both containers. Data lives
in the `cloud-data` volume and survives rebuilds.

```bash
docker compose -f deploy/cloud/docker-compose.yml ps        # state + web health
docker compose -f deploy/cloud/docker-compose.yml logs -f   # both services
docker compose -f deploy/cloud/docker-compose.yml down      # stop (data kept)
```

Web is on port `3002` and the embedded MQTT broker on `1883`. If either port is taken on the host,
set `IVORYOS_WEB_PORT` / `IVORYOS_MQTT_PORT` (in the shell or a `deploy/cloud/.env` file).

### Mode

Configuration is read from `cloud_frontend/.env.local`, exactly as without Docker:

- **LAN lab** (no `SUPABASE_URL`): SQLite on the volume, and the daemon runs its own MQTT broker.
  Edge devices pair against `http://<this-host>:3002` and connect to `<this-host>:1883`.
- **Hosted** (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set): Supabase and AWS IoT Core. Put
  the daemon's AWS IoT certificate files in `cloud_frontend/certs/` (mounted read-only at
  `/certs`) and point `AWS_IOT_CA_PATH` / `AWS_IOT_CERT_PATH` / `AWS_IOT_KEY_PATH` at `/certs/...`.
  The broker port is unused. If the web app is hosted elsewhere (e.g. Vercel), run only the daemon
  here: `docker compose -f deploy/cloud/docker-compose.yml up -d --build daemon`.

### Backup (LAN mode)

```bash
docker compose -f deploy/cloud/docker-compose.yml exec daemon \
  node -e "const db=new (process.getBuiltinModule('node:sqlite').DatabaseSync)('/data/ivoryos_cloud.db'); db.exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose -f deploy/cloud/docker-compose.yml cp daemon:/data/backup.db ./ivoryos_cloud-backup.db
```

`VACUUM INTO` takes a consistent copy while both services keep running.
