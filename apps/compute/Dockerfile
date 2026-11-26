# sondine-compute with speech.cpp's Vulkan build, for Linux and an NVIDIA card (ADR 040).
# Built from a folder holding this file and sondine-compute.js (README › Docker).

FROM node:24-bookworm-slim AS speech
# The release Sondine uses (SPEECH_CPP_RUNTIME), checked against its SHA256SUMS.
ARG SPEECH_VERSION=0.9.3
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/speech
RUN base=https://github.com/nyosegawa/speech.cpp/releases/download/v${SPEECH_VERSION} \
 && curl -fsSLO "$base/speech-${SPEECH_VERSION}-linux-x64-vulkan.zip" \
 && curl -fsSL "$base/SHA256SUMS" | grep linux-x64-vulkan | sha256sum -c - \
 && unzip -q "speech-${SPEECH_VERSION}-linux-x64-vulkan.zip" -d /opt/speech

FROM node:24-bookworm-slim
# NVIDIA's container runtime mounts the driver; the driver makes its Vulkan instance through EGL
# and X11, so the image needs their libraries, or Vulkan finds no device.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libvulkan1 libegl1 libx11-6 libxext6 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=speech /opt/speech /opt/speech
COPY sondine-compute.js /srv/sondine-compute.js
ENV SONDINE_COMPUTE_SPEECH=/opt/speech/speech \
    SONDINE_COMPUTE_MODEL=/models/model.gguf \
    SONDINE_COMPUTE_STATE=/state \
    HOME=/tmp
WORKDIR /srv
USER node
ENTRYPOINT ["node", "/srv/sondine-compute.js"]
CMD ["serve"]
