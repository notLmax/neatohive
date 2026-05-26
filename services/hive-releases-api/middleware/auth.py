from fastapi import Request


async def auth_middleware(request: Request, call_next):
    """No-op auth middleware for v1.5.0.

    INSERTION POINT for v1.5.x Clerk @neato.com restriction:
      1. Extract Bearer token from Authorization header
      2. Verify via Clerk JWKS endpoint (env: CLERK_JWKS_URL)
      3. Check decoded email domain ends with @neato.com
      4. On any failure: return JSONResponse(status_code=401, content={"error": "unauthenticated"})

    v1.5.0 passes all requests through unchanged. Public Cloud Run + future-Clerk-aware design.
    """
    return await call_next(request)
