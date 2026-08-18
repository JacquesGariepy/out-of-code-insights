from dataclasses import dataclass
from datetime import datetime
from typing import Optional, List

@dataclass
class AnnotationModel:
    id: str
    file_path: str
    line_number: int
    message: str
    author: str
    created_at: datetime
    tags: List[str]
    is_resolved: bool = False

    def summary(self) -> str:
        status = "RESOLVED" if self.is_resolved else "ACTIVE"
        return f"[{status}] {self.file_path}:{self.line_number} - {self.message}"

    def add_tag(self, tag: str) -> None:
        if tag not in self.tags:
            self.tags.append(tag)
