# `/proxy/v1/moderations`

This endpoint proxies requests to OpenAI's moderation API. It is used to moderate user-generated content before it is processed further.

This API is actually free from OpenAI, but it requires a positive (>$0) balance on the account to function, so for those who don't want to pay for OpenAI credits they'll never use, we route moderation requests through our shared OpenAI account. As it's free, we don't log anything from this API.
