from __future__ import annotations

import textwrap
import time
from datetime import datetime
from typing import TYPE_CHECKING

import anyio
from astrbot.api import logger
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import (
    AiocqhttpMessageEvent,
)

from ..config import PluginConfig
from ..utils import download_file, extract_image_url

if TYPE_CHECKING:
    from ..main import QQAdminPlugin


class NoticeHandle:
    def __init__(self, plugin: QQAdminPlugin, config: PluginConfig):
        self.plugin = plugin
        self.cfg = config

    async def send_group_notice(
        self,
        event: AiocqhttpMessageEvent,
        content: str = "",
        image_url: str | None = None,
    ):
        """(引用图片)发布群公告 xxx"""
        content = content or event.message_str.partition(" ")[2]
        if not content:
            return "未指定群公告内容"
        gid = event.get_group_id()
        image_path = ""
        if image_url := (image_url or extract_image_url(chain=event.get_messages())):
            img_name = f"{gid}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            temp_path = self.cfg.group_notice_dir / img_name

            logger.debug(f"Group notice image temp path: {temp_path}")
            image_path = await download_file(image_url, temp_path)
            if not image_path:
                return "图片获取失败"

            try:
                await event.bot.api.call_action(
                    "send_group_notice",
                    group_id=int(event.get_group_id()),
                    content=content,
                    image=str(image_path),
                )
            except AttributeError:
                await event.bot._send_group_notice(
                    group_id=int(event.get_group_id()),
                    content=content,
                    image=str(image_path),
                )
            # 清理 7 天前或超 50 张的旧图
            try:
                await self._cleanup_old_images()
            except Exception:
                pass
        event.stop_event()
        return "群公告已发布"

    async def _cleanup_old_images(self, keep: int = 50, max_age_days: int = 7):
        def _do():
            try:
                d = self.cfg.group_notice_dir
                if not d.exists():
                    return
                now = time.time()
                files = [(p, p.stat().st_mtime) for p in d.iterdir() if p.is_file()]
                files.sort(key=lambda x: x[1])
                cutoff = now - max_age_days * 86400
                for p, mtime in list(files):
                    if mtime < cutoff or len(files) > keep:
                        try:
                            p.unlink(missing_ok=True)
                            files.remove((p, mtime))
                        except Exception:
                            pass
            except Exception as e:
                logger.debug(f"清理群公告图片失败: {e}")

        await anyio.to_thread.run_sync(_do)

    async def get_group_notice(self, event: AiocqhttpMessageEvent):
        """查看群公告"""
        try:
            notices = await event.bot.api.call_action("get_group_notice", group_id=int(event.get_group_id()))
        except AttributeError:
            notices = await event.bot._get_group_notice(group_id=int(event.get_group_id()))

        formatted_messages = []
        for notice in notices:
            sender_id = notice["sender_id"]
            publish_time = datetime.fromtimestamp(notice["publish_time"]).strftime("%Y-%m-%d %H:%M:%S")
            message_text = notice["message"]["text"].replace("&#10;", "\n\n")

            formatted_message = f"【{publish_time}-{sender_id}】\n\n{textwrap.indent(message_text, '    ')}"
            formatted_messages.append(formatted_message)

        notices_str = "\n\n".join(formatted_messages)
        return notices_str or "当前群没有群公告"
