FROM python:3.11-slim

# OpenCV wheels need libGL/libglib even in headless builds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY rivals_ocr ./rivals_ocr
COPY serve.py ./

# Models are cached here; mount a volume to keep cold starts cheap.
ENV OCR_HOST=0.0.0.0 \
    OCR_PORT=8000 \
    PADDLE_PDX_MODEL_SOURCE=BOS

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"

CMD ["python", "serve.py"]
