# Immagine per qualunque servizio che esegue container (Fly.io, Railway, Koyeb, Google Cloud Run…).
FROM python:3.12-slim
WORKDIR /app
COPY . .
ENV NO_BROWSER=1 PYTHONDONTWRITEBYTECODE=1 PORT=8000
EXPOSE 8000
CMD ["python3", "app.py", "--no-browser"]
