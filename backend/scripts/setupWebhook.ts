export {}

// await import('node:crypto').then(it => it.randomBytes(180).toString('base64url'))

const args = process.argv.slice(2)

const url = new URL(`https://api.telegram.org/bot${args[0]}/setWebhook`)
url.searchParams.set('url', args[1])
url.searchParams.set('secret_token', args[2])
url.searchParams.set('allowed_updates', JSON.stringify([
  //'message',
  //'edited_message',
  'message_reaction',
]))

console.log(await fetch(url, { method: 'POST' }).then(it => it.json()))
