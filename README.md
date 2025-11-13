# hack club AI proxy

this is a lightweight LLM proxy, that amongst other things, implements:

- slack auth
- API keys
- chat and embedding model support
- global analytics
- usage statistic logging

is it the best code? probably not. but hey, it works!

you **must** have a reverse proxy (e.g. traefik) in front of the service to ensure that IPs aren't spoofed. we also highly recommend using openrouter, since it makes things like billing and provider ratelimits a lot less annoying, and also gives you much greater room to experiment and try out new models.
