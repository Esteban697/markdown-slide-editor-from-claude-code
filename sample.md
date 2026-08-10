# Markdown Viewer — Sample Document

A throwaway file for eyeballing the rendering. Drop it on the window, or open it
with <kbd>Ctrl</kbd>+<kbd>O</kbd>.

## Text formatting

Regular text with **bold**, *italic*, ***both***, `inline code`, ~~strikethrough~~,
and a [link to the Markdown spec](https://commonmark.org) that opens in your browser.

> Block quotes look like this.
>
> They can run for several paragraphs and contain **formatting** too.

Typographer is on, so "quotes" curl, dashes -- become en dashes, and (c) becomes ©.

## Lists

1. Ordered items
2. Second item
   - Nested bullet
   - Another nested bullet
     1. Deeply nested
3. Third item

### Task list

- [x] Dark mode
- [x] Drag and drop from File Explorer
- [x] Tabs
- [ ] Something still to do

## Code blocks

```js
// JavaScript with syntax highlighting
async function loadDocument (filePath) {
  const source = await fs.readFile(filePath, 'utf8')
  return { path: filePath, html: md.render(source), words: count(source) }
}
```

```python
# Python
def fib(n: int) -> list[int]:
    a, b, out = 0, 1, []
    for _ in range(n):
        out.append(a)
        a, b = b, a + b
    return out
```

```powershell
Get-ChildItem -Recurse -Filter *.md | Select-Object FullName, Length
```

An unlabelled block falls back to auto-detection:

```
SELECT name, size FROM files WHERE ext = '.md' ORDER BY size DESC;
```

## Tables

| Shortcut | Action | Notes |
| --- | --- | --- |
| `Ctrl+O` | Open files | Multi-select works |
| `Ctrl+W` | Close tab | Middle-click also closes |
| `Ctrl+Tab` | Next tab | `Ctrl+Shift+Tab` for previous |
| `Ctrl+1`…`Ctrl+9` | Jump to tab | `9` means *last* |
| `Ctrl+R` / `F5` | Reload | Happens automatically on save |
| `Ctrl+` `+` / `-` / `0` | Zoom | `Ctrl`+scroll wheel too |

## Headings for anchor testing

Jump to [Text formatting](#text-formatting) or [Tables](#tables).

#### Level four

##### Level five

###### Level six

---

## Embedded HTML

<div>
Raw HTML blocks render, but <code>&lt;script&gt;</code> tags and
<code>onclick=</code> handlers are blocked by the content security policy.
</div>

That's the end of the sample.
