"""HTTP routes, one module per area."""
from voisa_server.routes import pages, identity, recordings, relay_recordings, logs

ROUTERS = [pages.router, identity.router, recordings.router,
           relay_recordings.router, logs.router]
