"""Start the server:  python run.py   (add --reload while developing)"""
import argparse
import os

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the Service Request Management server")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    parser.add_argument("--reload", action="store_true", help="auto-restart on code changes")
    args = parser.parse_args()
    uvicorn.run("app.main:create_app", factory=True, host=args.host, port=args.port, reload=args.reload)
