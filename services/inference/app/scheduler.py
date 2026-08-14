from __future__ import annotations

import asyncio
import itertools
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(order=True)
class WorkItem(Generic[T]):
    priority: int
    sequence: int
    enqueued_at: float = field(compare=False)
    operation: Callable[[], T] = field(compare=False)
    future: asyncio.Future[tuple[T, float, float]] = field(compare=False)


class PriorityScheduler:
    def __init__(self) -> None:
        self.queue: asyncio.PriorityQueue[WorkItem[object]] = asyncio.PriorityQueue()
        self._sequence = itertools.count()
        self._task: asyncio.Task[None] | None = None

    @property
    def queued(self) -> int:
        return self.queue.qsize()

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def submit(self, priority: int, operation: Callable[[], T]) -> tuple[T, float, float]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[tuple[T, float, float]] = loop.create_future()
        await self.queue.put(
            WorkItem(priority, next(self._sequence), time.perf_counter(), operation, future)
        )
        return await future

    async def _run(self) -> None:
        while True:
            item = await self.queue.get()
            started = time.perf_counter()
            try:
                result = await asyncio.to_thread(item.operation)
                finished = time.perf_counter()
                item.future.set_result(
                    (result, (started - item.enqueued_at) * 1000, (finished - started) * 1000)
                )
            except Exception as exc:  # noqa: BLE001
                item.future.set_exception(exc)
            finally:
                self.queue.task_done()
