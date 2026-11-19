// 浏览器验收种子数据：向沙盒 DSH_HOME 写入一份带候选+卡片的材料。
// 用法：DSH_HOME=<dir> node scripts/seed.mjs
import { saveContent, saveCandidates, saveCards, saveSettings } from '../lib/store.js'

const TEXT = [
  'The catastrophic failure taught us a valuable lesson about redundancy.',
  'Engineers scrutinized every component, yet the culprit was a ubiquitous sensor.',
  'Resilience matters more than perfection in distributed systems.',
  'We brainstormed relentlessly and finally mitigated the bottleneck.',
  'This ubiquitous pattern recurs throughout the industry.',
].join('\n')

saveSettings({ gloss_lang: 'zh_CN', accent: 'us', max_cards: 30, proxy_url: '' })
const meta = saveContent({ title: '冗余的教训（验收种子）', source: 'text', sourceUrl: '', lang: 'en', text: TEXT })
saveCandidates(meta.content_id, [
  { term: 'catastrophic', type: 'word' },
  { term: 'scrutinized', type: 'word' },
  { term: 'ubiquitous', type: 'word' },
  { term: 'resilience', type: 'word' },
  { term: 'mitigated the bottleneck', type: 'phrase' },
])
saveCards(meta.content_id, [
  { term: 'catastrophic', reading: '', ipa: 'ˌkætəˈstrɑːfɪk', ipa_us: 'ˌkætəˈstrɑːfɪk', ipa_uk: 'ˌkætəˈstrɒfɪk', pos: '形容词', definition: '灾难性的；造成重大损失的', examples: ['a catastrophic failure\n一场灾难性的故障', 'catastrophic consequences\n灾难性的后果'], notes: '常与 failure / loss / consequences 搭配；比 disastrous 更强调「系统性崩溃」' },
  { term: 'scrutinized', reading: '', ipa: 'ˈskruːtənaɪzd', ipa_us: 'ˈskruːtənaɪzd', ipa_uk: 'ˈskrʊtənaɪzd', pos: '动词', definition: '仔细检查；细致审查', examples: ['Engineers scrutinized every component.\n工程师们仔细检查了每个部件。', 'scrutinize the logs\n审查日志'], notes: '名词形式 scrutiny；近义 examine，但 scrutinize 强调「带怀疑的细看」' },
  { term: 'ubiquitous', reading: '', ipa: 'juːˈbɪkwɪtəs', ipa_us: 'juːˈbɪkwɪtəs', ipa_uk: 'juːˈbɪkwɪtəs', pos: '形容词', definition: '无处不在的；十分普遍的', examples: ['a ubiquitous sensor\n一个无处不在的传感器', 'Smartphones are ubiquitous.\n智能手机无处不在。'], notes: '名词 ubiquity；正式书面语' },
  { term: 'resilience', reading: '', ipa: 'rɪˈzɪliəns', ipa_us: 'rɪˈzɪliəns', ipa_uk: 'rɪˈzɪliəns', pos: '名词', definition: '韧性；快速恢复的能力', examples: ['Resilience matters in distributed systems.\n在分布式系统中韧性至关重要。', 'economic resilience\n经济韧性'], notes: '形容词 resilient；工程语境指「故障后自愈能力」' },
  { term: 'mitigated the bottleneck', reading: '', ipa: '', ipa_us: '', ipa_uk: '', pos: '短语', definition: '缓解了瓶颈', examples: ['We finally mitigated the bottleneck.\n我们最终缓解了瓶颈。', 'mitigate risks\n降低风险'], notes: 'mitigate + 风险/影响/瓶颈；同 alleviate，但更正式' },
])
console.log('seeded:', meta.content_id)
