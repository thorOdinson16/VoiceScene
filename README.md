# Voice Scene

Voice Scene is a local 3D scene editor built with Three.js, Vite, Express, and the OpenAI API. It renders a JSON scene graph, accepts push-to-talk commands, transcribes them, and applies validated tool calls to the scene.

The editor supports three primitives: boxes, spheres, and cylinders. You can edit a scene directly as JSON or issue voice commands such as “add a red cylinder”, “spin the orange sphere”, or “make it orbit”.

## Features

- Live Three.js rendering with JSON scene editing.
- Push-to-talk recording and Whisper transcription.
- Tool-based scene operations for adding, modifying, deleting, animating, and moving the camera.
- Continuous spin and orbit animations.
- Deterministic object-reference resolution for existing-scene commands.
- Per-request tool schemas that only expose current object IDs for existing-object operations.
- Safe application of tool calls through scene-graph validation.

## Requirements

- Node.js 20 or later.
- An OpenAI API key with access to the configured chat-completions and transcription models.
- A modern browser with microphone access.

Microphone capture works on `localhost` during development. A deployed version must use HTTPS for browser microphone access.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file from the example:

   ```bash
   Copy-Item .env.example .env
   ```

3. Set your OpenAI API key in `.env`:

   ```dotenv
   OPENAI_API_KEY=your_openai_api_key_here
   ```

4. Start the client and API server:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:5173](http://localhost:5173).

The Vite client proxies `/api` requests to the Express API at `http://localhost:3001`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Starts Vite and the Express API together. |
| `npm run dev:client` | Starts only the Vite client. |
| `npm run dev:server` | Starts only the Express API with watch mode. |
| `npm run build` | Type-checks the project and creates a production client build in `dist/`. |
| `npm run preview` | Serves the built client for local preview. |

## How It Works

```text
Browser microphone
  -> POST /api/transcribe
  -> Whisper transcription
  -> POST /api/agent-turn
  -> intent detection
  -> deterministic entity resolution when needed
  -> GPT tool call
  -> tool-call validation
  -> applyToolCalls()
  -> SceneDiffRenderer
  -> Three.js canvas
```

### Scene Updates

The browser stores the current scene graph. A valid JSON edit or successful agent turn is parsed with `parseSceneGraph`, then passed to `SceneDiffRenderer`. The renderer updates only changed Three.js objects and preserves mesh instances when possible.

The animation loop uses `requestAnimationFrame`. On every frame it updates active animations and renders the scene. Spin animations set `rotation.y`; orbit animations move the object around the origin in the XZ plane using the radius captured when the animation started.

### Voice Commands

Hold the **Hold to speak** button, speak a command, then release it. The browser sends the audio to `/api/transcribe`; the returned transcript is sent with the current scene to `/api/agent-turn`.

The server uses the OpenAI transcription model `whisper-1` and the configured chat model in `src-server/agent.ts`.

## Deterministic Entity Resolution

The agent pipeline treats object creation and existing-object commands differently.

### Creation Commands

Commands beginning with these creation verbs bypass entity resolution and are sent to the model unchanged:

- `add`
- `create`
- `spawn`
- `make`
- `generate`
- `insert`
- `place`
- `put`

Examples:

```text
Add a red cylinder.
Create a blue cube.
Spawn an orange sphere.
Make a green box.
```

Creation commands are expected to use `add_object`; a new object ID is allowed for that tool only.

### Existing-Object Commands

All other object commands use the resolver before reaching the model. It resolves, in order:

1. An exact current object ID.
2. A focused pronoun such as `it`, `that one`, or `this one` when `lastFocusedId` still exists.
3. A unique color and/or primitive match, including `cube` as an alias for `box` and `ball` as an alias for `sphere`.

For example, when `blue-box` is the only blue box, this command is rewritten before it reaches GPT:

```text
Rotate the blue cube.
```

```text
Rotate object "blue-box".
```

If no current object matches, or several objects match, the server returns a clarification and makes no tool calls. This prevents a model from selecting a similar-looking but unintended object.

The client records the last ID returned in a successful object-oriented tool call and sends it as `lastFocusedId` on the next request. Consequently, “make it orbit” targets the previously focused object only while that object is still present in the scene.

### Tool-Call Safety

For each agent request, `modify_object`, `remove_object`, `animate`, and `stop_animate` receive a dynamic JSON schema whose `id` parameter is an enum of the current scene IDs. The model cannot select an unknown ID through those schemas.

The server also validates returned tool calls independently. A malformed call, unknown tool, or unknown existing-object ID rejects the entire turn and returns a clarification; invalid calls are never partially applied.

## Supported Commands

Examples below assume the referenced object exists and is unambiguous.

| Action | Example |
| --- | --- |
| Add an object | `Add a red cylinder.` |
| Change an object | `Make the blue cube bigger.` |
| Move an object | `Move the orange sphere left.` |
| Remove an object | `Delete the green cylinder.` |
| Start spinning | `Spin the orange sphere.` |
| Start orbiting | `Make it orbit.` |
| Stop animation | `Stop the animation on blue-box.` |
| Set camera | `Move the camera closer.` |

Unsupported or ambiguous requests should return a short clarification instead of modifying the scene.

## Scene JSON

The editor accepts a single JSON scene object. The required top-level fields are `objects`, `camera`, and `lighting`; `animations` is optional.

```json
{
  "objects": [
    {
      "id": "blue-box",
      "type": "box",
      "position": [-1.2, 0, 0],
      "color": "#3b82f6",
      "scale": [1, 1, 1]
    },
    {
      "id": "orange-sphere",
      "type": "sphere",
      "position": [1.2, 0, 0],
      "color": "#f97316",
      "scale": [0.8, 0.8, 0.8]
    }
  ],
  "camera": {
    "position": [0, 2.5, 6],
    "target": [0, 0, 0],
    "fov": 50
  },
  "lighting": {
    "ambient": { "color": "#ffffff", "intensity": 1.2 },
    "directional": {
      "color": "#ffffff",
      "intensity": 2,
      "position": [3, 4, 5]
    }
  },
  "animations": [
    { "id": "orange-sphere", "type": "spin", "speed": 0.001 }
  ]
}
```

### Validation Rules

- Object IDs must be non-empty and unique.
- Object `type` must be `box`, `sphere`, or `cylinder`.
- `position` and `scale` are three finite numbers: `[x, y, z]`.
- Camera position and target are also three-number vectors.
- Colors are strings understood by Three.js.
- Animations reference an object ID and use either `spin` or `orbit`.

## API

### `POST /api/transcribe`

Accepts multipart form data with an `audio` file. The server returns:

```json
{ "transcript": "Spin the orange sphere." }
```

The upload limit is 25 MB.

### `POST /api/agent-turn`

Accepts JSON:

```json
{
  "transcript": "Spin the orange sphere.",
  "currentScene": { "...": "SceneGraph" },
  "context": { "lastFocusedId": "orange-sphere" }
}
```

Returns the applied scene plus the agent result:

```json
{
  "scene": { "...": "updated SceneGraph" },
  "toolCalls": [
    {
      "name": "animate",
      "arguments": {
        "id": "orange-sphere",
        "type": "spin",
        "speed": 0.001
      }
    }
  ]
}
```

When the target is unclear, `toolCalls` is empty and the response includes `clarification`.

## Project Structure

```text
src/
  main.ts             Browser UI, recording flow, API requests, render loop
  diff-renderer.ts    Incremental Three.js scene synchronization and animation updates
  scene-graph.ts      Scene types, validation, example scene, and tool-call application
  style.css           Application styles
src-server/
  index.ts            Express API for transcription and agent turns
  agent.ts            Intent detection, entity resolution, tool schemas, and GPT calls
index.html            Application document
vite.config.ts        Development proxy configuration
```

## Troubleshooting

### `OPENAI_API_KEY is not configured`

Create `.env` beside `package.json` and set `OPENAI_API_KEY`. Restart the API server after changing environment variables.

### The browser cannot access the microphone

Allow microphone permission for `localhost`. Confirm that no operating-system privacy setting or another application is blocking the input device.

### A command returns a clarification

Use an exact scene object ID or give a unique color/type description. For example, prefer `rotate blue-box` over `rotate the box` when multiple boxes exist.

### An animation appears too fast or too slow

Animation speed is multiplied by the animation-frame timestamp. Adjust the `speed` value in the scene JSON or issue a new animation command with a more suitable speed.

### The API request fails

Confirm both development processes are running with `npm run dev`, then check the terminal output from the Express server for the upstream error.

## Development Notes

- Keep scene changes flowing through `parseSceneGraph` and `applyToolCalls`; they are the validation and mutation boundary.
- Preserve the server-side entity resolver when extending object-oriented commands. Do not accept arbitrary IDs for existing-object tools.
- Keep `.env` private. It is intentionally excluded from version control.
