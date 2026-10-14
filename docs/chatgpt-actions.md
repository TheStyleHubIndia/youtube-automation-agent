# Connect ChatGPT to YouTube Automation Agent

This repository exposes a ChatGPT Actions-compatible OpenAPI schema at:

`https://YOUR_PUBLIC_HTTPS_HOST/api/chatgpt/openapi.json`

## Configure the server

1. Deploy this app to a publicly reachable HTTPS host. ChatGPT Actions cannot call a private localhost URL.
2. Set `API_KEY` to a long, random secret in the server environment. Do not commit the key to Git.
3. Set `PUBLIC_BASE_URL` to the app's public HTTPS origin, without a trailing slash, for example `https://automation.example.com`.
4. Configure both `OPENAI_API_KEY` and `GEMINI_API_KEY` if you want provider failover. The explicitly configured provider is primary; another configured provider is tried if the primary request fails.
5. Complete the YouTube OAuth walkthrough and verify that the channel connection is ready.
6. Open the ChatGPT GPT builder, add an Action, and import the schema URL above.
7. Configure API-key authentication with header name `x-api-key` and the same secret stored as `API_KEY` on the server.
8. Test `getAutomationStatus`, then `generateYouTubeContent`, then poll `getYouTubeGenerationJob`. Use `getYouTubePublishingSchedule` to inspect upcoming schedule entries.

## Safety and behavior

- The Actions schema endpoint is public, but every operational Action requires the configured API key. If `API_KEY` is unset, those endpoints fail closed with HTTP 503.
- The generation Action starts a job; it does not bypass the application's approval, provenance, media-rights, or production-readiness checks.
- A future YouTube publish time is sent as `status.publishAt` only when the video is private and the time is valid and in the future. YouTube documents that `publishAt` is valid only for private videos that have never been published.
- Keep all API keys and OAuth token files on the server. Never put secrets in the OpenAPI schema or a client-side app.
