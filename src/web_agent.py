"""
Courtesy Web Agent & Live Documentation Engine
Provides real-time internet search, documentation scraping, and context grounding
for Ollama coding models across the cluster.
"""

import asyncio
import logging
import re
import urllib.parse
from typing import List, Dict, Any, Optional, Tuple

import httpx
import bs4

logger = logging.getLogger("courtesy.web_agent")

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# Keywords that indicate user is looking for current documentation, APIs, or modern information
INTENT_KEYWORDS = {
    "api", "docs", "documentation", "latest", "update", "updates", "changelog",
    "release", "new", "version", "syntax", "library", "package", "how to", "frc",
    "wpilib", "rev", "ctre", "phoenix", "pathplanner", "photonvision", "limelight",
    "pydantic", "fastapi", "vue", "react", "nextjs", "tailwind", "rust", "crates",
    "golang", "python 3", "2024", "2025", "2026"
}

URL_REGEX = re.compile(r'https?://[^\s<>"\')]+')


async def search_web(query: str, max_results: int = 5) -> List[Dict[str, str]]:
    """
    Searches the live web for documentation, API references, and current info.
    Returns a list of dicts with keys: 'title', 'href', 'snippet'.
    """
    clean_query = query.strip()
    if not clean_query:
        return []

    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote_plus(clean_query)}"
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
    }

    results = []
    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                soup = bs4.BeautifulSoup(resp.text, "html.parser")
                for el in soup.select(".result"):
                    if len(results) >= max_results:
                        break
                    title_a = el.select_one(".result__title a")
                    snippet_el = el.select_one(".result__snippet")
                    if title_a:
                        raw_href = title_a.get("href", "")
                        # Decode DuckDuckGo redirect url
                        if "uddg=" in raw_href:
                            try:
                                href = urllib.parse.unquote(raw_href.split("uddg=")[1].split("&")[0])
                            except Exception:
                                href = raw_href
                        else:
                            href = raw_href

                        # Filter out internal ads/trackers
                        if "duckduckgo.com" in href and "html" in href:
                            continue

                        title = title_a.get_text().strip()
                        snippet = snippet_el.get_text().strip() if snippet_el else ""
                        results.append({
                            "title": title,
                            "href": href,
                            "snippet": snippet
                        })
        except Exception as e:
            logger.warning(f"Web search error for '{clean_query}': {e}")

    return results


async def fetch_webpage(url: str, max_chars: int = 4500) -> str:
    """
    Fetches a webpage or documentation link and extracts clean, readable text.
    """
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8"
    }

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                return f"[Failed to fetch {url}: HTTP {resp.status_code}]"

            content_type = resp.headers.get("content-type", "")
            if "text/plain" in content_type or "text/markdown" in content_type or url.endswith((".md", ".txt", ".json")):
                return resp.text[:max_chars]

            soup = bs4.BeautifulSoup(resp.text, "html.parser")

            # Remove non-content elements
            for tag in soup(["script", "style", "nav", "footer", "header", "svg", "noscript", "iframe"]):
                tag.decompose()

            # Prefer main documentation container if present
            main_el = soup.find("main") or soup.find("article") or soup.find(class_=re.compile(r"content|doc|body|markdown", re.I)) or soup.body
            if main_el:
                lines = []
                for p in main_el.find_all(["h1", "h2", "h3", "h4", "p", "pre", "li"]):
                    text = p.get_text().strip()
                    if text:
                        if p.name in ["h1", "h2", "h3"]:
                            lines.append(f"\n### {text}\n")
                        elif p.name == "pre":
                            lines.append(f"```\n{text}\n```")
                        else:
                            lines.append(text)
                clean_text = "\n".join(lines)
            else:
                clean_text = soup.get_text(separator="\n", strip=True)

            # Collapse multi-newlines
            clean_text = re.sub(r'\n{3,}', '\n\n', clean_text).strip()
            return clean_text[:max_chars]

        except Exception as e:
            logger.warning(f"Error fetching webpage '{url}': {e}")
            return f"[Error fetching documentation from {url}: {e}]"


def extract_urls(text: str) -> List[str]:
    """Finds all HTTP/HTTPS URLs in a text."""
    return URL_REGEX.findall(text)


def detect_web_intent(prompt: str) -> bool:
    """
    Checks if a prompt would benefit from live web search or doc retrieval.
    """
    lower = prompt.lower()
    if extract_urls(prompt):
        return True

    # Check for library or API queries
    words = re.findall(r'\b[a-zA-Z0-9_\-\.]+\b', lower)
    for w in words:
        if w in INTENT_KEYWORDS:
            return True

    return False


async def generate_grounded_context(user_prompt: str, force: bool = False) -> Tuple[Optional[str], List[Dict[str, str]]]:
    """
    Analyzes the user prompt. If relevant or forced, searches the web or scrapes
    provided URLs and builds an up-to-date documentation grounding context block.
    """
    sources: List[Dict[str, str]] = []
    grounding_blocks: List[str] = []

    # 1. Scrape explicit URLs provided in the prompt
    pasted_urls = extract_urls(user_prompt)
    if pasted_urls:
        for u in pasted_urls[:2]:
            doc_content = await fetch_webpage(u, max_chars=3500)
            if doc_content and not doc_content.startswith("[Failed"):
                sources.append({"title": u, "url": u})
                grounding_blocks.append(f"#### Source: [{u}]({u})\n{doc_content}")

    # 2. If forced or query expresses intent to get modern docs/APIs
    should_search = force or detect_web_intent(user_prompt)
    if should_search and len(sources) < 3:
        # Formulate query
        search_query = user_prompt.replace("\n", " ").strip()
        # Clean common prompt conversational prefixes
        search_query = re.sub(r'^(can you|please|how to|write|create|give me|show me)\s+', '', search_query, flags=re.I)
        search_query = search_query[:120].strip()

        search_results = await search_web(search_query, max_results=4)
        if search_results:
            for r in search_results:
                sources.append({"title": r["title"], "url": r["href"]})
                snippet = r["snippet"]
                if snippet:
                    grounding_blocks.append(f"#### [{r['title']}]({r['href']})\n> {snippet}")

            # Also deep-fetch the top 1 result if it looks like an authoritative doc
            top = search_results[0]
            top_url = top["href"]
            if any(k in top_url for k in ["docs.", "github.com", "readthedocs", "wiki", "api."]):
                deep_text = await fetch_webpage(top_url, max_chars=2500)
                if deep_text and not deep_text.startswith("[Failed") and len(deep_text) > 150:
                    grounding_blocks.append(f"#### Detailed Documentation Snippet: [{top['title']}]({top_url})\n{deep_text}")

    if not grounding_blocks:
        return None, []

    context_markdown = (
        "\n\n---\n"
        "### 🌐 Live Web & Modern Documentation Grounding\n"
        "*The following up-to-date web and API references were fetched in real-time to ground your response:*\n\n"
        + "\n\n".join(grounding_blocks)
        + "\n---\n"
        "Please use the latest APIs, correct parameters, and modern idioms from the above documentation in your code.\n"
    )

    return context_markdown, sources


# OpenAI-compatible function calling tool schemas
OPENAI_SEARCH_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the live internet for modern up-to-date documentation, API signatures, release notes, and code syntax.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The exact search query (e.g. 'wpilib 2025 rev robotics cansparkmax api', 'pydantic v2 model_validator syntax')"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_documentation",
            "description": "Fetch and read the full text content of a documentation or webpage URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The web URL to fetch and read."
                    }
                },
                "required": ["url"]
            }
        }
    }
]
