#!/usr/bin/env python3
import json
import os
import sys
import urllib.request

import lark_oapi as lark


CALLBACK_URL = os.environ["LARK_EVENT_CALLBACK_URL"]
CALLBACK_SECRET = os.environ.get("LARK_EVENT_CALLBACK_SECRET", "")


def post_event(data):
    payload = lark.JSON.marshal(data)
    req = urllib.request.Request(
        CALLBACK_URL,
        data=payload.encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Sync-Secret": CALLBACK_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8")
        print(json.dumps({
            "posted": True,
            "status": resp.status,
            "response": body[:500],
        }, ensure_ascii=False), flush=True)


def on_bitable_record_changed(data):
    try:
        post_event(data)
    except Exception as exc:
        print(json.dumps({
            "posted": False,
            "error": repr(exc),
        }, ensure_ascii=False), file=sys.stderr, flush=True)


def main():
    event_handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_drive_file_bitable_record_changed_v1(on_bitable_record_changed)
        .build()
    )
    client = lark.ws.Client(
        os.environ["LARK_APP_ID"],
        os.environ["LARK_APP_SECRET"],
        event_handler=event_handler,
        log_level=lark.LogLevel.INFO,
        domain=lark.LARK_DOMAIN,
    )
    print("lark event listener starting", flush=True)
    client.start()


if __name__ == "__main__":
    main()
