# Choosing an AI provider

[Русский](ai-providers.md) · [README](../README.md)

Set the provider, key, and model in **Settings → AI agent**. Changing only the model keeps the saved API key; you do not need to enter it again. Changes take effect without restarting the app.

## We recommend DeepSeek

We recommend **DeepSeek** for everyday agent use. In our experience with server administration tasks, it responded several times faster than the models we tried through OpenCode Go. Speed depends on the model, conversation size, and provider load: this is an observation from our use of the project, rather than a universal benchmark result.

Select the **DeepSeek** preset, enter an API key, and keep the default `deepseek-v4-flash` model or enter another available model. This preset enables web search automatically.

## OpenCode Go subscription

ssh-commander supports an **OpenCode Go** subscription key directly; you do not need to run the OpenCode client. Select the **OpenCode Go** preset, enter your subscription key, and enter a model name without the `opencode-go/` prefix. The preset uses `https://opencode.ai/zen/go/v1` and defaults to `glm-5.3-flash`.

**Not every subscription model is supported.** Compatibility depends on the protocol OpenCode exposes for that model:

| Model protocol | Support in ssh-commander |
|---|---|
| OpenAI Chat Completions | Supported; `glm-5.3-flash` has been tested, including tool calls. |
| OpenAI Responses | Supported for `gpt-6-luna`, `gpt-5.6-luna`, `grok-4.7`, `grok-4.6`, `muse-spark-1.3-contributor`, and `muse-spark-1.2-contributor`; the protocol is selected automatically. `gpt-6-luna` has been tested, including tool calls. |
| Anthropic Messages | Not supported yet. Models available only through this protocol cannot be used. |

The model list and endpoints can change; check your chosen model against the [OpenCode Go documentation](https://opencode.ai/docs/go/#endpoints). Supporting a new Responses model name may require a ssh-commander update.

Go support was added after the prebuilt **0.1.1** image. Until the next release, use a [source build](installation.en.md#source-build).

The Go preset does not enable web search automatically. Subscription limits and upstream model provider limits still apply: `rate_limit_exceeded` means a request or token limit was exceeded, and `ModelProtocolUnsupported` means the chosen model does not support the request protocol.
