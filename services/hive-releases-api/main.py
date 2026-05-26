from fastapi import FastAPI

from middleware.auth import auth_middleware
from routers import current

app = FastAPI(
    title="hive-releases-api",
    description=(
        "Public API for the Neato Hive release pipeline. Returns current "
        "release metadata for `hive update`."
    ),
    version="0.1.0",
)

app.middleware("http")(auth_middleware)
app.include_router(current.router, prefix="/api")
