# Casa Organizada - Deploy en Heroku

## Donde guardar el estado compartido

Para Heroku, guarda el estado en **Postgres** (`DATABASE_URL`).

- `localStorage` no sirve para compartir entre 2 personas.
- Un archivo `.json` dentro del dyno tampoco es confiable en Heroku (filesystem efimero).
- Este proyecto ahora usa `GET/PUT /api/state` y persiste en Postgres si existe `DATABASE_URL`.
- Solo para desarrollo local sin DB, hace fallback a `state.json`.

## Variables importantes

- `PORT`: la define Heroku automaticamente.
- `DATABASE_URL`: la define Heroku al agregar Heroku Postgres.
- `LOCAL_STATE_FILE` (opcional): ruta del json local de fallback.

## Deploy rapido

1. Crear app en Heroku

```bash
heroku create <tu-app>
```

2. Agregar Postgres

```bash
heroku addons:create heroku-postgresql:mini
```

3. Deploy

```bash
git add .
git commit -m "Prepare app for Heroku with shared Postgres state"
git push heroku main
```

4. Abrir app

```bash
heroku open
```

## Endpoints

- `GET /health` -> estado del servidor y tipo de storage (`postgres` o `json-file`).
- `GET /api/state` -> devuelve `{ data, revision }`.
- `PUT /api/state` -> recibe `{ data }` y guarda el estado compartido.
