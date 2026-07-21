# Lemonade — the AI model server (operator notes for Claude)

Lemonade runs on the **Windows gaming PC**, NOT on s2-server. It serves
every local AI workload — chat, embeddings, STT, TTS, image-gen — on the
GPU. s2-server reaches it over the LAN and fronts it with LiteLLM, so
Open WebUI (and any OpenAI-SDK caller) only ever talks to the gateway,
never Lemonade directly.

## ⚠️ Always use the LIVE API docs — don't trust copies

Authoritative, current reference (fetch it before relying on specifics):
- **https://lemonade-server.ai/docs/api/lemonade/**
- OpenAI-compat subpages under the same docs tree (`.../openai/`, etc.)

The model catalog, exact request fields, and quant filenames drift.
`WebFetch` the docs (and query the running server) rather than trusting
any value written in THIS file. This file is orientation only.

## Reaching it — drive the API, skip the GUI

- Base URL: `http://gaming-pc.local.toscanini.me:13305`
  (pi-hole resolves it to `192.168.0.120`).
- Path prefix: `/api/v1/...` (also `/v1`, `/v0`, `/api/v0`).
- Auth: **none on the LAN** (no `LEMONADE_API_KEY` set) — plain `curl`
  from s2-server works.
- **Prefer driving the management API directly** over asking the user to
  click through the Lemonade GUI. Most "go do X in Lemonade" tasks are
  one API call.

## Hardware (stable)

- Ryzen 7 7800X3D, 32 GB RAM, Windows 11.
- GPU: **AMD RX 7900 XTX, 24 GB VRAM** (gfx1100), the discrete card
  (ROCm device 1). Also an iGPU (gfx1036) — models load on the dGPU.

## What I can do via the management API (verify fields against the docs)

- `GET /api/v1/health` — loaded models + per-model backend_url / device /
  health + pin counts. The status endpoint.
- `GET /api/v1/models` (`?show_all=true`) — catalog, `downloaded`, ids,
  labels, `image_defaults`. `GET /api/v1/models/{id}/files`.
- `POST /api/v1/pull` — install/register a model (the API behind the GUI
  "From JSON": `model_name`, `checkpoint`/`checkpoints`, `recipe`, …).
- `POST /api/v1/load` — load into VRAM with `pinned`, `ctx_size`,
  `llamacpp_backend`, `save_options`. `POST /api/v1/unload` — free VRAM /
  release a file handle.
- `POST /api/v1/delete` — remove a model.
- `GET /api/v1/downloads` + `POST /api/v1/downloads/control`
  (`pause`/`cancel`/`remove`) — manage or clear a stuck download.
- `POST /api/v1/install` / `uninstall` — backends (e.g. the Vulkan
  sd-cpp backend). `GET /api/v1/system-info` — recipe/backend support
  matrix + VRAM.
- OpenAI-compat (what LiteLLM proxies): `/api/v1/{chat/completions,
  embeddings, images/generations, audio/speech, audio/transcriptions}`.
  Plus Lemonade extensions (`audio/generations` music, `3d/generations`).

## How it maps to this system

Each Lemonade model **id** becomes a LiteLLM `model_name` in
`stacks/litellm/assets/config.yaml`: `model: openai/<id>`,
`api_base: http://gaming-pc.local.toscanini.me:13305/api/v1`, a `mode:`
(chat / embedding / audio_speech / audio_transcription /
image_generation), cost pinned to 0. Open WebUI env points its
RAG/AUDIO/IMAGES/chat settings at `litellm:4000`. See the litellm.nix
header + the open-webui stack.

## Operational quirks (this box — not in the API docs)

- **On-demand load + LRU auto-eviction.** A request loads the model;
  when VRAM is tight the least-recently-used one is evicted (cold reload
  next call). Pass `pinned:true` on `/load` to keep a model warm.
  Several coexist up to 24 GB — each is its own backend process on its
  own port (see `/health`). kokoro TTS runs on **CPU** (0 VRAM).
- **ROCm split:** llama.cpp ROCm works (Gemma/embeddings on GPU), but
  **StableDiffusion.cpp ROCm crashes** — the `sd-cpp:rocm` build is
  missing the rocBLAS Tensile library for gfx1100 (`rocBLAS error:
  Cannot read …TensileLibrary.dat … for GPU arch gfx1100`, empty list) →
  sd-server watchdog reset. Fix: supply the Tensile lib (TheRock has it
  under `…\bin\therock\gfx110X-*\`) or set the sd-cpp backend →
  **Vulkan** (no rocBLAS). Image-gen is otherwise fully wired.
- **Custom multi-file image models** (Flux/Chroma) need
  `checkpoints:{main,text_encoder,vae}` + `recipe:"sd-cpp"`. The GUI
  "From JSON" wants a FLAT object with `model_name` (`user.` prefix) +
  `recipe` at the TOP level, not name-keyed like `user_models.json`.
  Chroma is FLUX.1-based → T5-XXL encoder + FLUX.1 VAE (`ae.safetensors`);
  use an UNGATED VAE repo (BFL FLUX.1-schnell is gated → hash error).
- **Windows download quirk:** a finished download can fail on the final
  rename ("file used by another process") — usually Defender scanning
  the fresh GGUF. Retry resumes from the partial; a Defender exclusion on
  `C:\Users\micro\.cache\huggingface` prevents it.
- Turbo image models use CFG 1 + few steps; Chroma is NOT turbo (real
  CFG ~3.5, ~30 steps). `image_defaults` are per-model.
