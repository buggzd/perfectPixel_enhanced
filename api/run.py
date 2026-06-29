"""Entrypoint: launch the Perfect Pixel video API with uvicorn."""

from __future__ import annotations

import uvicorn

from api.server import HOST, PORT, app  # noqa: F401


def main() -> None:
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
