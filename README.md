# OR Proxy

A bit inspired by "CrushedAsian" in the OR discord and I made a simple open router proxy which is lighter and has api-key based ratelimits, thats it.
this uses `http` which is a tad bit faster than `express` :), though im primarily experienced with fastify, so any prs are welcome 

### free endpoint

Im hosting this at `or-proxy.glorious.host` (i dont have a personal domain yet so ill use this for convinence)

use https://or-proxy.glorious.host/v1 for openai base url

rate limits are set at `60 req / minute` and `1000 / 30 mins` PER api key (please be nice and dont abuse it)

max 1 mb request & 120s timeout (configurable if you manually deploy via .env)