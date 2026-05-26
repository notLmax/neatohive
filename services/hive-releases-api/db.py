import os
from urllib.parse import quote_plus

from sqlalchemy import create_engine
from sqlalchemy.orm import scoped_session, sessionmaker


def make_database_url() -> str:
    direct_url = os.environ.get("DATABASE_URL")
    if direct_url:
        return direct_url

    db_user = os.environ.get("DB_USER", "hive_releases_user")
    db_password = quote_plus(os.environ.get("DB_PASSWORD", ""))
    db_name = os.environ.get("DB_NAME", "hive_releases")
    socket_dir = os.environ.get("CLOUD_SQL_SOCKET_DIR", "/cloudsql")
    connection_name = os.environ.get(
        "CLOUD_SQL_CONNECTION_NAME",
        "neato-os:us-central1:neato-os-db",
    )
    return (
        f"postgresql+psycopg2://{db_user}:{db_password}@/{db_name}"
        f"?host={socket_dir}/{connection_name}"
    )


engine = create_engine(make_database_url(), pool_pre_ping=True)
SessionLocal = scoped_session(
    sessionmaker(autocommit=False, autoflush=False, bind=engine)
)


def get_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
