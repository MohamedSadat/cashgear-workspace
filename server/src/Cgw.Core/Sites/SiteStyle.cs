using System.Security.Cryptography;
using System.Text;

namespace Cgw.Core.Sites;

/// <summary>
/// The one stylesheet every site page carries inline, and its hash for the Content Security
/// Policy (<c>style-src 'sha256-…'</c>): no other style may run, not even an attribute. Light and
/// dark from the reader's system; logical properties only, so a right-to-left page mirrors itself;
/// colours as the document's named tokens, never a value from the document.
/// </summary>
public static class SiteStyle
{
    public const string Css = """
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#57606a;--line:#d0d7de;--soft:#f6f8fa;--accent:#0b57d0;--accent-fg:#ffffff;--bar:#0b57d0;--bar-2:#7a4a1e;
--gray:#475467;--brown:#7a4a1e;--orange:#b54708;--yellow:#7a5d00;--green:#067647;--blue:#175cd3;--purple:#6941c6;--pink:#c11574;--red:#b42318;
--gray-bg:#eaecf0;--brown-bg:#f4e8dc;--orange-bg:#fdead7;--yellow-bg:#fef7c3;--green-bg:#dcfae6;--blue-bg:#d1e9ff;--purple-bg:#ebe9fe;--pink-bg:#fce7f6;--red-bg:#fee4e2}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--soft:#161b22;--accent:#8ab4f8;--accent-fg:#0d1117;--bar:#8ab4f8;--bar-2:#d6a77a;
--gray:#a3a9b4;--brown:#d6a77a;--orange:#f7b27a;--yellow:#f5d060;--green:#6ce9a6;--blue:#84adff;--purple:#bdb4fe;--pink:#faa7e0;--red:#ff8c82;
--gray-bg:#2b3038;--brown-bg:#3b2a1c;--orange-bg:#40260f;--yellow-bg:#3a3110;--green-bg:#0f3321;--blue-bg:#102a4c;--purple-bg:#2a2252;--pink-bg:#40122f;--red-bg:#451510}}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Arabic",Tahoma,sans-serif}
body{margin:0}
a{color:var(--accent)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.skip{position:absolute;inset-inline-start:-9999px}
.skip:focus{inset-inline-start:1rem;inset-block-start:1rem;background:var(--accent);color:var(--accent-fg);padding:.5rem 1rem;z-index:1}
.site-header{border-block-end:1px solid var(--line);padding:.75rem 1.5rem;font-weight:600}
.site-header a{color:var(--fg);text-decoration:none}
.layout{display:flex;flex-wrap:wrap;gap:2rem;padding:1.5rem;max-inline-size:84rem;margin-inline:auto}
.tree{flex:0 1 16rem;min-inline-size:12rem;font-size:.95rem}
.tree ul{list-style:none;margin:0;padding-inline-start:1rem}
.tree>ul{padding-inline-start:0}
.tree li{margin-block:.15rem}
.tree a{display:inline-block;min-block-size:24px;color:var(--fg);text-decoration:none;padding-inline:.25rem;border-radius:4px}
.tree a:hover{background:var(--soft)}
.tree a[aria-current=page]{background:var(--soft);font-weight:600}
main{flex:1 1 32rem;min-inline-size:0}
.cover{display:block;inline-size:100%;max-block-size:16rem;object-fit:cover;border-radius:8px;margin-block-end:1rem}
h1{font-size:2rem;line-height:1.25;margin:.5rem 0 1rem}
h2{font-size:1.5rem;margin:1.5rem 0 .5rem}h3{font-size:1.25rem;margin:1.25rem 0 .5rem}h4{font-size:1.1rem;margin:1rem 0 .5rem}
p{margin:.25rem 0}
.icon{margin-inline-end:.35rem}
.children{padding-inline-start:1.5rem}
ul,ol{margin:.25rem 0;padding-inline-start:1.5rem}
.checks{list-style:none;padding-inline-start:0}
.checks label{display:inline-flex;gap:.5rem;align-items:baseline}
.checks input{min-inline-size:16px;min-block-size:16px}
.checks .done{color:var(--muted);text-decoration:line-through}
blockquote{margin:.5rem 0;padding-inline-start:1rem;border-inline-start:3px solid var(--line)}
.callout{display:flex;gap:.6rem;margin:.5rem 0;padding:.75rem 1rem;border-radius:8px;background:var(--soft);border:1px solid var(--line)}
.callout.tone-info{background:var(--blue-bg)}.callout.tone-success{background:var(--green-bg)}.callout.tone-warning{background:var(--yellow-bg)}.callout.tone-danger{background:var(--red-bg)}
details{margin:.25rem 0}
summary{cursor:pointer;min-block-size:24px}
pre{direction:ltr;text-align:left;background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:.75rem 1rem;overflow-x:auto;font-size:.9rem}
pre.wrap{white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
p code,li code,td code{background:var(--soft);padding:.05rem .3rem;border-radius:4px}
hr{border:0;border-block-start:1px solid var(--line);margin:1rem 0}
figure{margin:.75rem 0}
figure img{max-inline-size:100%;block-size:auto;border-radius:6px}
figure.align-center{text-align:center}figure.align-end{text-align:end}
figcaption{color:var(--muted);font-size:.9rem}
.table-wrap{overflow-x:auto;margin:.5rem 0}
table{border-collapse:collapse;min-inline-size:50%}
th,td{border:1px solid var(--line);padding:.35rem .6rem;text-align:start;vertical-align:top}
th{background:var(--soft)}
caption{text-align:start;font-weight:600;padding-block:.25rem}
.placeholder{margin:.5rem 0;padding:.75rem 1rem;border:1px dashed var(--line);border-radius:8px;color:var(--muted)}
.bookmark,.file{display:inline-block;margin:.25rem 0;padding:.5rem .75rem;border:1px solid var(--line);border-radius:6px;min-block-size:24px}
.mention{font-weight:500}
.database{margin:1rem 0}
.db-title{font-weight:600;margin-block-end:.25rem}
.count,.pager{color:var(--muted);font-size:.9rem}
.pager{display:flex;gap:1rem;align-items:center;margin-block:.75rem}
.option{display:inline-block;padding:0 .4rem;border-radius:4px;background:var(--gray-bg);margin-inline-end:.25rem}
.board{display:flex;gap:1rem;overflow-x:auto;padding-block:.5rem}
.column{flex:0 0 15rem;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:.5rem}
.column h3,.column h4{font-size:1rem;margin:.25rem 0 .5rem}
.cards{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
.card{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.5rem}
.card dl{margin:.25rem 0 0;font-size:.9rem}
.card dt{color:var(--muted)}
.card dd{margin:0 0 .25rem}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:1rem;list-style:none;padding:0}
.gallery img{inline-size:100%;block-size:8rem;object-fit:cover;border-radius:4px}
.chart svg{inline-size:100%;max-inline-size:40rem;block-size:auto}
.chart .bar{fill:var(--bar)}.chart .line{fill:none;stroke:var(--bar);stroke-width:3}.chart .dot{fill:var(--bar)}
.chart .slice-0{fill:var(--blue)}.chart .slice-1{fill:var(--orange)}.chart .slice-2{fill:var(--green)}.chart .slice-3{fill:var(--purple)}.chart .slice-4{fill:var(--red)}.chart .slice-5{fill:var(--yellow)}.chart .slice-6{fill:var(--pink)}.chart .slice-7{fill:var(--brown)}
.chart .axis{stroke:var(--line)}.chart text{fill:var(--fg);font-size:12px}
.chart .number{font-size:2.5rem;font-weight:600}
.c-gray{color:var(--gray)}.c-brown{color:var(--brown)}.c-orange{color:var(--orange)}.c-yellow{color:var(--yellow)}.c-green{color:var(--green)}.c-blue{color:var(--blue)}.c-purple{color:var(--purple)}.c-pink{color:var(--pink)}.c-red{color:var(--red)}
.h-gray,.o-gray{background:var(--gray-bg)}.h-brown,.o-brown{background:var(--brown-bg)}.h-orange,.o-orange{background:var(--orange-bg)}.h-yellow,.o-yellow{background:var(--yellow-bg)}.h-green,.o-green{background:var(--green-bg)}.h-blue,.o-blue{background:var(--blue-bg)}.h-purple,.o-purple{background:var(--purple-bg)}.h-pink,.o-pink{background:var(--pink-bg)}.h-red,.o-red{background:var(--red-bg)}
mark{color:inherit;background:var(--yellow-bg)}
footer{border-block-start:1px solid var(--line);color:var(--muted);font-size:.85rem;padding:1rem 1.5rem;text-align:center}
.gone{max-inline-size:40rem;margin:4rem auto;padding:0 1.5rem}
@media print{.tree,.skip,footer{display:none}}
""";

    /// <summary>The CSP source for <see cref="Css"/>: <c>'sha256-…'</c> of its UTF-8 bytes, as browsers hash a style element's text.</summary>
    public static readonly string Hash = $"'sha256-{Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(Css)))}'";
}
