#!/usr/bin/env python3
"""
双会话协作台账（见 COORDINATION.md）。

    python tools/coordinate.py status
    python tools/coordinate.py say    --from verify --kind result --text "..."
    python tools/coordinate.py handoff --to verify --status ready_for_test --next "..."
    python tools/coordinate.py claim  --as impl
    python tools/coordinate.py test   --by verify --render 31/31 --edit 10/10 --ops 22/22 --overall pass
    python tools/coordinate.py wait   --for verify --timeout 1800
    python tools/coordinate.py log    --tail 10

设计要点：
* STATE.json 用「读-改-写 + 文件锁」保证两个会话不会互相覆盖；
* MESSAGES.jsonl / TESTS.jsonl 只追加；
* wait 轮询 STATE.json，不占 CPU、不写任何文件。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COORD = ROOT / "coordination"
STATE = COORD / "STATE.json"
MESSAGES = COORD / "MESSAGES.jsonl"
TESTS = COORD / "TESTS.jsonl"
LOCK = COORD / ".lock"


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def ensure() -> None:
    COORD.mkdir(parents=True, exist_ok=True)
    if not STATE.exists():
        STATE.write_text(
            json.dumps(
                {
                    "round": 1,
                    "phase": "first-batch",
                    "owner": "verify",
                    "busy": False,
                    "waiting_for": "impl",
                    "status": "in_progress",
                    "last_run": None,
                    "next": "验收方扩 O 系列用例；实现方处理 E 系列失败项",
                    "updated_at": now(),
                    "updated_by": "verify",
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    for path in (MESSAGES, TESTS):
        if not path.exists():
            path.write_text("", encoding="utf-8")


class Lock:
    """极简文件锁：O_EXCL 创建，超时 10 秒。"""

    def __init__(self, path: Path, timeout: float = 10.0):
        self.path = path
        self.timeout = timeout

    def __enter__(self):
        deadline = time.time() + self.timeout
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                if time.time() > deadline:
                    raise SystemExit(f"lock timeout: {self.path}")
                time.sleep(0.1)

    def __exit__(self, *_exc):
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def read_state() -> dict:
    ensure()
    return json.loads(STATE.read_text(encoding="utf-8-sig"))


def write_state(state: dict, *, by: str) -> None:
    state["updated_at"] = now()
    state["updated_by"] = by
    tmp = STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE)


def append(path: Path, record: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def parse_fraction(text: str) -> dict:
    try:
        done, total = text.split("/")
        return {"pass": int(done), "fail": int(total) - int(done)}
    except (ValueError, AttributeError):
        return {"pass": 0, "fail": 0, "raw": text}


def cmd_status(_args) -> int:
    state = read_state()
    print(json.dumps(state, ensure_ascii=False, indent=2))
    return 0


def cmd_say(args) -> int:
    ensure()
    with Lock(LOCK):
        append(
            MESSAGES,
            {
                "ts": now(),
                "from": args.sender,
                "round": read_state().get("round"),
                "kind": args.kind,
                "text": args.text,
            },
        )
    print(f"said ({args.kind}): {args.text}")
    return 0


def cmd_handoff(args) -> int:
    ensure()
    with Lock(LOCK):
        state = read_state()
        state["round"] = int(state.get("round", 1)) + 1
        state["owner"] = args.to
        state["waiting_for"] = args.to
        state["busy"] = False
        state["status"] = args.status
        state["next"] = args.next or ""
        write_state(state, by=args.sender)
        append(
            MESSAGES,
            {
                "ts": now(),
                "from": args.sender,
                "round": state["round"],
                "kind": "handoff",
                "text": f"→ {args.to}: {args.next or ''}",
            },
        )
    print(f"handoff -> {args.to} (round {state['round']}, {args.status})")
    return 0


def cmd_claim(args) -> int:
    ensure()
    with Lock(LOCK):
        state = read_state()
        state["owner"] = args.as_role
        state["busy"] = True
        state["status"] = "in_progress"
        state["waiting_for"] = None
        write_state(state, by=args.as_role)
    print(f"claimed by {args.as_role} (round {state['round']})")
    return 0


def cmd_test(args) -> int:
    ensure()
    with Lock(LOCK):
        record = {
            "ts": now(),
            "round": read_state().get("round"),
            "by": args.by,
            "render": parse_fraction(args.render),
            "edit": parse_fraction(args.edit),
            "ops": parse_fraction(args.ops),
            "failed": [item for item in (args.failed or "").split(",") if item],
            "pending": [item for item in (args.pending or "").split(",") if item],
            "overall": args.overall,
        }
        append(TESTS, record)
        state = read_state()
        state["last_run"] = {
            "at": record["ts"],
            "render": args.render,
            "edit": args.edit,
            "ops": args.ops,
            "overall": args.overall,
        }
        state["status"] = "passed" if args.overall == "pass" else "blocked"
        state["owner"] = "impl"
        state["waiting_for"] = "impl"
        state["busy"] = False
        if args.next:
            state["next"] = args.next
        write_state(state, by=args.by)
        append(
            MESSAGES,
            {
                "ts": now(),
                "from": args.by,
                "round": state["round"],
                "kind": "result",
                "text": (
                    f"render {args.render} edit {args.edit} ops {args.ops} "
                    f"=> {args.overall}"
                ),
            },
        )
    print(f"test recorded: render {args.render} edit {args.edit} ops {args.ops} ({args.overall})")
    return 0


def cmd_wait(args) -> int:
    ensure()
    deadline = time.time() + args.timeout
    # 只认"开始等待之后发生的新交接"：否则 STATE 早就停在 owner=impl 时，
    # wait 会立刻返回，等于没有等。
    started = read_state()
    baseline_updated = started.get("updated_at", "")
    baseline_round = started.get("round", 0)
    while True:
        state = read_state()
        fresh = (
            state.get("updated_at", "") > baseline_updated
            or state.get("round", 0) > baseline_round
        )
        # 对方还在写（busy=true）时绝不返回，哪怕状态已经是 passed。
        if (
            fresh
            and state.get("owner") == args.for_role
            and state.get("status") in {"ready_for_test", "passed", "blocked"}
            and not state.get("busy")
        ):
            print(json.dumps(state, ensure_ascii=False, indent=2))
            return 0
        if time.time() > deadline:
            print(f"timeout waiting for {args.for_role}", file=sys.stderr)
            print(json.dumps(state, ensure_ascii=False, indent=2))
            return 1
        time.sleep(args.interval)


def cmd_log(args) -> int:
    ensure()
    messages = [json.loads(line) for line in MESSAGES.read_text(encoding="utf-8").splitlines() if line.strip()]
    tests = [json.loads(line) for line in TESTS.read_text(encoding="utf-8").splitlines() if line.strip()]
    print("== recent messages ==")
    for item in messages[-args.tail :]:
        print(f"[{item['ts']}] r{item.get('round')} {item['from']}/{item['kind']}: {item['text']}")
    print("== recent test runs ==")
    for item in tests[-args.tail :]:
        print(
            f"[{item['ts']}] r{item.get('round')} {item['by']}: "
            f"render {item['render']} edit {item['edit']} ops {item['ops']} => {item['overall']}"
        )
    if not args.follow:
        return 0
    seen = len(messages)
    print("== following (Ctrl+C to stop) ==")
    try:
        while True:
            if not MESSAGES.exists():
                time.sleep(1)
                continue
            lines = [line for line in MESSAGES.read_text(encoding="utf-8").splitlines() if line.strip()]
            for line in lines[seen:]:
                item = json.loads(line)
                print(f"[{item['ts']}] r{item.get('round')} {item['from']}/{item['kind']}: {item['text']}")
            seen = len(lines)
            time.sleep(2)
    except KeyboardInterrupt:
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status").set_defaults(func=cmd_status)

    say = sub.add_parser("say")
    say.add_argument("--from", dest="sender", required=True, choices=["impl", "verify"])
    say.add_argument("--kind", default="note", choices=["handoff", "result", "blocked", "note"])
    say.add_argument("--text", required=True)
    say.set_defaults(func=cmd_say)

    handoff = sub.add_parser("handoff")
    handoff.add_argument("--from", dest="sender", required=True, choices=["impl", "verify"])
    handoff.add_argument("--to", required=True, choices=["impl", "verify"])
    handoff.add_argument("--status", default="ready_for_test", choices=["in_progress", "ready_for_test", "passed", "blocked"])
    handoff.add_argument("--next", default="")
    handoff.set_defaults(func=cmd_handoff)

    claim = sub.add_parser("claim")
    claim.add_argument("--as", dest="as_role", required=True, choices=["impl", "verify"])
    claim.set_defaults(func=cmd_claim)

    test = sub.add_parser("test")
    test.add_argument("--by", required=True, choices=["impl", "verify"])
    test.add_argument("--render", default="0/0")
    test.add_argument("--edit", default="0/0")
    test.add_argument("--ops", default="0/0")
    test.add_argument("--overall", required=True, choices=["pass", "fail"])
    test.add_argument("--failed", default="")
    test.add_argument("--pending", default="")
    test.add_argument("--next", default="")
    test.set_defaults(func=cmd_test)

    wait = sub.add_parser("wait")
    wait.add_argument("--for", dest="for_role", required=True, choices=["impl", "verify"])
    # 默认 24 小时：协作场景下"等对方"是常态，不应该几分钟就超时。
    wait.add_argument("--timeout", type=float, default=86400)
    wait.add_argument("--interval", type=float, default=10)
    wait.set_defaults(func=cmd_wait)

    log = sub.add_parser("log")
    log.add_argument("--tail", type=int, default=10)
    log.add_argument("--follow", action="store_true")
    log.set_defaults(func=cmd_log)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
