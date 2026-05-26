from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from db import get_session
from main import app
from middleware.auth import auth_middleware
from models import Release

REQUIRED_FIELDS = {
    "version",
    "tarball_url",
    "checksum_sha256",
    "released_at",
    "changelog_url",
}


@pytest.fixture
def fake_release() -> Release:
    return Release(
        version="1.5.0",
        tarball_url=(
            "https://neato-hive-site.vercel.app/releases/v1.5.0/"
            "neato-hive-v1.5.0.tar.gz"
        ),
        checksum_sha256="0000000000000000000000000000000000000000000000000000000000000000",
        released_at=datetime(2026, 5, 6, tzinfo=timezone.utc),
        changelog_url="https://neato-hive-site.vercel.app/changelog.html",
        release_notes_summary=None,
        deprecated_at=None,
    )


@pytest.fixture(autouse=True)
def clear_dependency_overrides() -> None:
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def make_session_mock(result) -> MagicMock:
    session = MagicMock()
    session.execute.return_value.scalar_one_or_none.return_value = result
    return session


def override_session(result):
    def _override():
        yield make_session_mock(result)

    return _override


@pytest.mark.asyncio
async def test_api_current_returns_200(fake_release: Release) -> None:
    app.dependency_overrides[get_session] = override_session(fake_release)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/current")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_api_current_response_shape(fake_release: Release) -> None:
    app.dependency_overrides[get_session] = override_session(fake_release)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/current")

    assert set(response.json()) == REQUIRED_FIELDS


@pytest.mark.asyncio
async def test_api_current_returns_db_data(fake_release: Release) -> None:
    app.dependency_overrides[get_session] = override_session(fake_release)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/current")

    payload = response.json()
    assert payload["version"] == "1.5.0"
    assert payload["checksum_sha256"] == (
        "0000000000000000000000000000000000000000000000000000000000000000"
    )
    assert payload["released_at"] == "2026-05-06T00:00:00Z"


@pytest.mark.asyncio
async def test_api_current_500_on_no_active_release() -> None:
    app.dependency_overrides[get_session] = override_session(None)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/current")

    assert response.status_code == 500
    assert response.json() == {"detail": "no active release found"}


@pytest.mark.asyncio
async def test_auth_middleware_passthrough(fake_release: Release) -> None:
    app.dependency_overrides[get_session] = override_session(fake_release)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/current",
        "raw_path": b"/api/current",
        "query_string": b"",
        "headers": [],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    request = Request(scope)
    sentinel = object()

    async def call_next(passed_request: Request):
        assert passed_request is request
        return sentinel

    response = await auth_middleware(request, call_next)

    assert response is sentinel
