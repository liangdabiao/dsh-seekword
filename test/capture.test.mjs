// capture.test.mjs — 网页正文提取
import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText } from '../lib/capture.js'

test('htmlToText：剥 script/style/nav/footer，块级标签换行，实体解码', () => {
  const html = `<!doctype html><html><head><title>T</title>
    <style>.x{color:red}</style><script>var a=1;</script></head>
    <body>
      <nav><a href="#">Home</a><a href="#">Docs</a></nav>
      <article><h1>Resilience</h1>
        <p>Systems suffer &amp; recover &mdash; that&#39;s life.</p>
        <p>Second paragraph here.</p>
      </article>
      <footer>copyright footer link</footer>
    </body></html>`
  const text = htmlToText(html)
  assert.ok(text.includes('Resilience'))
  assert.ok(text.includes('Systems suffer & recover'))
  assert.ok(text.includes("that's life."))
  assert.ok(text.includes('Second paragraph here.'))
  assert.ok(!text.includes('var a=1'))
  assert.ok(!text.includes('.x{color:red}'))
  assert.ok(!text.includes('Home')) // nav 短行去重/剥除
  assert.ok(!text.includes('copyright footer'))
})

test('htmlToText：重复短行去重（菜单噪声）', () => {
  const html = '<div><p>Menu</p><p>Menu</p><p><a href="#">Menu</a></p><p>Real content paragraph that is long enough to keep.</p></div>'
  const text = htmlToText(html)
  assert.equal(text.split('\n').filter((l) => l.toLowerCase() === 'menu').length, 1)
  assert.ok(text.includes('Real content paragraph'))
})
