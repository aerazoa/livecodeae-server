# LivecodeAE Relay Server

Servidor de relé Socket.IO para la extensión LivecodeAE de VS Code.
Permite colaboración en tiempo real desde cualquier red de internet.

## Despliegue en Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

## Uso local

```bash
npm install
npm start
```

El servidor queda disponible en `http://localhost:4815`.

## Variables de entorno

| Variable | Descripción | Default |
|----------|-------------|---------|
| `PORT`   | Puerto del servidor | `4815` |

## Endpoints

- `GET /` — Estado del servidor
- `GET /health` — Health check
