// Prove senza rete: node test.mjs
import assert from 'node:assert/strict';
import { parseFeed, decodeEntities, xText, facebookText, telegramText, freshPreviewUrl, oauthHeader } from './autopost.mjs';

assert.equal(decodeEntities('Bell&#8217;Italia &amp; co'), 'Bell’Italia & co');

const xml = `<rss><channel><item>
<title>Bell&#8217;Italia con Agenda 2027</title><link>https://tuttoinedicola.it/a/</link>
<pubDate>Sat, 31 Oct 2026 07:32:00 +0000</pubDate>
<category><![CDATA[Omaggi in Edicola]]></category><category><![CDATA[Bell'Italia]]></category>
<guid isPermaLink="false">https://tuttoinedicola.it/?p=2142</guid>
<description><![CDATA[<p>È già in edicola l&#8217;Agenda [&#8230;]</p><p>L'articolo <a href="x">y</a></p>]]></description>
</item></channel></rss>`;
const [it] = parseFeed(xml);
assert.equal(it.title, 'Bell’Italia con Agenda 2027');
assert.equal(it.excerpt, 'È già in edicola l’Agenda');
assert.deepEqual(it.categories, ['Omaggi in Edicola', "Bell'Italia"]);
assert.equal(xText(it), 'Bell’Italia con Agenda 2027\n\nhttps://tuttoinedicola.it/a/');
assert.equal(facebookText(it), 'Bell’Italia con Agenda 2027');
assert.equal(telegramText(it), 'Bell’Italia con Agenda 2027\nhttps://tuttoinedicola.it/a/');
const long = { ...it, title: 'Titolo '.repeat(60) };
assert.ok(xText(long).replace(long.link, 'x'.repeat(23)).length <= 280);

assert.equal(freshPreviewUrl('https://x.it/a/', 5), 'https://x.it/a/?tgpreview=5');
assert.equal(freshPreviewUrl('https://x.it/?p=1', 5), 'https://x.it/?p=1&tgpreview=5');

// Esempio ufficiale della documentazione X/Twitter (firma OAuth 1.0a)
const h = oauthHeader('POST', 'https://api.twitter.com/1.1/statuses/update.json',
  { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
  { consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
  'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', 1318622958);
assert.ok(h.includes('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'), h);
console.log('Tutte le prove sono passate ✅');
