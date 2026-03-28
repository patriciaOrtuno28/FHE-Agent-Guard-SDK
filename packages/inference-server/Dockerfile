FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends binutils && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "concrete-ml==1.7.0" \
    "fastapi==0.111.0" \
    "uvicorn[standard]==0.30.1" \
    "pydantic==2.7.1" \
    "numpy>=1.24.0,<2.0.0"

COPY server.py .

EXPOSE 8000

CMD ["python", "server.py"]