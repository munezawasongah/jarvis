# Optional: run the voice worker in the cloud (e.g. a second Railway service) instead of on your laptop.
# Variables: JARVIS_URL (https address of Jarvis), JARVIS_TOKEN, HF_TOKEN (Hugging Face read token with
# access to kyutai/pocket-tts). Your voice sample is sent to it by Jarvis automatically.
# Needs about 1.5 GB RAM. Mount a volume at /app/voices so the learnt voice survives restarts.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
COPY jarvis_voice.py .
RUN mkdir -p voices
CMD ["python", "-u", "jarvis_voice.py"]
