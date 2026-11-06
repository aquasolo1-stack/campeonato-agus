# Campeonato Agus

App web para el campeonato de truco. Los jugadores se anotan sin crear cuenta. Después se sortean equipos de 3, se juega una fase de grupos todos contra todos y una llave de eliminación. En "Mi partido" cada uno ve su equipo y su próximo rival.

| Parte | Qué es |
|---|---|
| `public/index.html` | Frontend (HTML, CSS y JS, sin build) |
| `server.js` | Backend Node + Express con API REST |
| SQLite en `/data` | Base de datos dentro de un **volumen** persistente |

## Correr con Docker (recomendado)

```bash
cp .env.example .env        # y cambiá ADMIN_PIN
docker compose up -d --build
```

Abrí http://localhost:3000. Los datos quedan en el volumen `campeonato-data`, y sobreviven a reinicios y redeploys.

Para hacer un backup:

```bash
docker compose exec app node -e "require('better-sqlite3')('/data/campeonato.db').backup('/data/backup.db')"
docker cp campeonato-agus:/data/backup.db ./backup.db
```

## Correr sin Docker

```bash
npm install
ADMIN_PIN=1234 npm start     # datos en ./data
npm test                     # tests de la API
```

## Publicar con tu dominio

- **VPS (DigitalOcean, Hetzner, etc.):** levantás `docker compose up -d` y ponés adelante un proxy con HTTPS (Caddy, Nginx o Traefik) que apunte al puerto 3000.
- **Railway / Render / Fly.io:** desplegás desde este repo (detectan el `Dockerfile`), agregás un **volumen montado en `/data`** y la variable `ADMIN_PIN`, y conectás el dominio en la configuración del servicio.

Vercel o Netlify **no** sirven para esta versión, porque no tienen volúmenes persistentes.

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `ADMIN_PIN` | (vacío) | PIN del organizador. Sin PIN nadie puede administrar. |
| `PORT` | `3000` | Puerto HTTP. |
| `DATA_DIR` | `/data` en Docker, `./data` local | Carpeta donde se guarda la base de datos. |

## API

| Método | Ruta | Quién |
|---|---|---|
| GET | `/api/state?since=<versión>` | Todos |
| POST | `/api/players` `{nombre}` → `{id, token}` | Todos |
| DELETE | `/api/players/:id` (header `X-Player-Token` o `X-Admin-Pin`) | El jugador o el organizador |
| POST | `/api/admin/login` `{pin}` | Organizador |
| POST | `/api/admin/players` `{nombre}` | Organizador |
| PUT | `/api/admin/torneo` `{torneo}` | Organizador |
| PUT | `/api/admin/config` `{inscripcionAbierta, cierre, formato, equiposPorGrupo, tantos, eliminatoria}` | Organizador |
| POST | `/api/admin/reset` `{confirm:"BORRAR TODO"}` | Organizador |

Las rutas de organizador llevan el header `X-Admin-Pin`. La inscripción tiene un límite de intentos por IP y el login de organizador también.
