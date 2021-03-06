const Eris = require('eris');
const fs = require('fs');
const moment = require('moment');
const humanizeDuration = require('humanize-duration');
const config = require('../config');
const Queue = require('./queue');
const utils = require('./utils');
const blocked = require('./blocked');
const threads = require('./threads');
const logs = require('./logs');
const attachments = require('./attachments');
const snippets = require('./snippets');
const webserver = require('./webserver');
const greeting = require('./greeting');

const prefix = config.prefix || '!';
const snippetPrefix = config.snippetPrefix || prefix.repeat(2);

const bot = new Eris.CommandClient(config.token, {}, {
  prefix: prefix,
  ignoreSelf: true,
  ignoreBots: true,
  defaultHelpCommand: false,
  getAllUsers: true,
  defaultCommandOptions: {
    caseInsensitive: true,
  },
});

const messageQueue = new Queue();

bot.on('ready', () => {
  bot.editStatus(null, {name: config.status || 'Message me for help'});
  console.log('Bot started, listening to DMs');
});

function isStaff(member) {
  if (! config.inboxServerPermission) return true;
  return member.permission.has(config.inboxServerPermission);
}

function formatAttachment(attachment) {
  let filesize = attachment.size || 0;
  filesize /= 1024;

  return attachments.getUrl(attachment.id, attachment.filename).then(attachmentUrl => {
    return `**Attachment:** ${attachment.filename} (${filesize.toFixed(1)}KB)\n${attachmentUrl}`;
  });
}

// If the alwaysReply option is set to true, send all messages in modmail threads as replies, unless they start with the prefix
if (config.alwaysReply) {
  bot.on('messageCreate', msg => {
    if (! msg.channel.guild) return;
    if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
    if (! isStaff(msg.member)) return;
    if (msg.author.bot) return;
    if (msg.content[0] == bot.commandOptions.prefix) return;

    reply(msg, msg.content.trim(), config.alwaysReplyAnon || false);
  });
}

// "Bot was mentioned in #general-discussion"
bot.on('messageCreate', msg => {
  if (msg.author.id === bot.user.id) return;

  if (msg.mentions.some(user => user.id === bot.user.id)) {
    // If the person who mentioned the modmail bot is on the modmail server, don't ping about it
    if (utils.getModmailGuild(bot).members.get(msg.author.id)) return;

    blocked.isBlocked(msg.author.id).then(isBlocked => {
      if (isBlocked) return;

      bot.createMessage(utils.getModmailGuild(bot).id, {
        content: `@here Bot mentioned in ${msg.channel.mention} by **${msg.author.username}#${msg.author.discriminator}**: "${msg.cleanContent}"`,
        disableEveryone: false,
      });
    });
  }
});

// When we get a private message, forward the contents to the corresponding modmail thread
bot.on('messageCreate', (msg) => {
  if (! (msg.channel instanceof Eris.PrivateChannel)) return;
  if (msg.author.id === bot.user.id) return;

  blocked.isBlocked(msg.author.id).then(isBlocked => {
    if (isBlocked) return;

    // Download and save copies of attachments in the background
    const attachmentSavePromise = attachments.saveAttachmentsInMessage(msg);

    let thread, userLogs;
    let threadCreationFailed = false;

    // Private message handling is queued so e.g. multiple message in quick succession don't result in multiple channels being created
    messageQueue.add(() => {
      return threads.getForUser(bot, msg.author, true, msg)
        .then(userThread => {
          thread = userThread;
          return logs.getLogsByUserId(msg.author.id);
        }, err => {
          console.log(`[ERROR] Modmail channel for ${msg.author.username}#${msg.author.discriminator} could not be created:\n${err.message}`);
          threadCreationFailed = true;
        })
        .then(foundUserLogs => {
          userLogs = foundUserLogs;
        })
        .then(() => {
          let content = msg.content;

          if (threadCreationFailed) {
            // If the thread could not be created, send a warning about this to all mods so they can DM the user directly instead
            let warningMessage = `
@here Error creating modmail thread for ${msg.author.username}#${msg.author.discriminator} (${msg.author.id})!

Here's what their message contained:
\`\`\`${content}\`\`\`
          `.trim();

            bot.createMessage(utils.getModmailGuild(bot).id, {
              content: warningMessage,
              disableEveryone: false,
            });

            return;
          } else if (! thread) {
            // No thread but creation didn't fail either -> probably ignored
            return;
          }

          let threadInitDonePromise = Promise.resolve();

          // If the thread was just created, do some extra stuff
          if (thread._wasCreated) {
            const member = utils.getMainGuild(bot).members.get(msg.author.id);

            if (! member) {
              console.log(`Member ${msg.author.id} not found in main guild ${config.mainGuildId}`);
            }

            let mainGuildNickname = null;
            if (member && member.nick) mainGuildNickname = member.nick;
            else if (member && member.user) mainGuildNickname = member.user.username;
            else if (member == null) mainGuildNickname = 'NOT ON SERVER';

            if (mainGuildNickname == null) mainGuildNickname = 'UNKNOWN';

            const accountAge = humanizeDuration(Date.now() - msg.author.createdAt, {largest: 2});
            const infoHeader = `ACCOUNT AGE **${accountAge}**, ID **${msg.author.id}**, NICKNAME **${mainGuildNickname}**, LOGS **${userLogs.length}**\n-------------------------------`;

            threadInitDonePromise = bot.createMessage(thread.channelId, infoHeader).then(() => {
              // Ping mods of the new thread
              return bot.createMessage(thread.channelId, {
                content: `@here New modmail thread (${msg.author.username}#${msg.author.discriminator})`,
                disableEveryone: false,
              });
            });

            // Send an automatic reply to the user informing them of the successfully created modmail thread
            msg.channel.createMessage(config.responseMessage || "Thank you for your message! Our mod team will reply to you here as soon as possible.").then(null, (err) => {
              bot.createMessage(utils.getModmailGuild(bot).id, {
                content: `There is an issue sending messages to ${msg.author.username}#${msg.author.discriminator} (id ${msg.author.id}); consider messaging manually`
              });
            });
          }

          const attachmentsPendingStr = '\n\n*Attachments pending...*';
          if (msg.attachments.length > 0) content += attachmentsPendingStr;

          threadInitDonePromise.then(() => {
            const timestamp = utils.getTimestamp();
            bot.createMessage(thread.channelId, `[${timestamp}] « **${msg.author.username}#${msg.author.discriminator}:** ${content}`).then(createdMsg => {
              if (msg.attachments.length === 0) return;

              // Once attachments have been saved, add links to them to the message
              attachmentSavePromise.then(() => {
                const attachmentFormatPromises = msg.attachments.map(formatAttachment);
                Promise.all(attachmentFormatPromises).then(formattedAttachments => {
                  let attachmentMsg = '';

                  formattedAttachments.forEach(str => {
                    attachmentMsg += `\n\n${str}`;
                  });

                  createdMsg.edit(createdMsg.content.replace(attachmentsPendingStr, attachmentMsg));
                });
              });
            });
          });
        });
    });
  });
});

// Edits in DMs
bot.on('messageUpdate', (msg, oldMessage) => {
  if (! (msg.channel instanceof Eris.PrivateChannel)) return;
  if (msg.author.id === bot.user.id) return;

  blocked.isBlocked(msg.author.id).then(isBlocked => {
    if (isBlocked) return;

    let oldContent = oldMessage.content;
    const newContent = msg.content;

    if (oldContent == null) oldContent = '*Unavailable due to bot restart*';

    // Ignore bogus edit events with no changes
    if (newContent.trim() === oldContent.trim()) return;

    threads.getForUser(bot, msg.author).then(thread => {
      if (! thread) return;

      const editMessage = utils.disableLinkPreviews(`**The user edited their message:**\n\`B:\` ${oldContent}\n\`A:\` ${newContent}`);

      bot.createMessage(thread.channelId, editMessage);
    });
  });
});

function reply(msg, text, anonymous = false) {
  threads.getByChannelId(msg.channel.id).then(thread => {
    if (! thread) return;

    attachments.saveAttachmentsInMessage(msg).then(() => {
      bot.getDMChannel(thread.userId).then(dmChannel => {
        let modUsername, logModUsername;
        const mainRole = utils.getMainRole(msg.member);

        if (anonymous) {
          modUsername = (mainRole ? mainRole.name : 'Moderator');
          logModUsername = `(Anonymous) (${msg.author.username}) ${mainRole ? mainRole.name : 'Moderator'}`;
        } else {
          const name = (config.useNicknames ? msg.member.nick || msg.author.username : msg.author.username);
          modUsername = (mainRole ? `(${mainRole.name}) ${name}` : name);
          logModUsername = modUsername;
        }

        let content = `**${modUsername}:** ${text}`;
        let logContent = `**${logModUsername}:** ${text}`;

        function sendMessage(file, attachmentUrl) {
          dmChannel.createMessage(content, file).then(() => {
            if (attachmentUrl) {
              content += `\n\n**Attachment:** ${attachmentUrl}`;
              logContent += `\n\n**Attachment:** ${attachmentUrl}`;
            }

            // Show the message in the modmail thread as well
            const timestamp = utils.getTimestamp();
            msg.channel.createMessage(`[${timestamp}] » ${logContent}`);
          }, (err) => {
            if (err.resp && err.resp.statusCode === 403) {
              msg.channel.createMessage(`Could not send reply; the user has likely left the server or blocked the bot`);
            } else if (err.resp) {
              msg.channel.createMessage(`Could not send reply; error code ${err.resp.statusCode}`);
            } else {
              msg.channel.createMessage(`Could not send reply: ${err.toString()}`);
            }
          });

          msg.delete();
        };

        // If the reply has an attachment, relay it as is
        if (msg.attachments.length > 0) {
          fs.readFile(attachments.getPath(msg.attachments[0].id), (err, data) => {
            const file = {file: data, name: msg.attachments[0].filename};

            attachments.getUrl(msg.attachments[0].id, msg.attachments[0].filename).then(attachmentUrl => {
              sendMessage(file, attachmentUrl);
            });
          });
        } else {
          sendMessage();
        }
      });
    });
  });
}

// Mods can reply to modmail threads using !r or !reply
// These messages get relayed back to the DM thread between the bot and the user
bot.registerCommand('reply', (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  const text = args.join(' ').trim();
  reply(msg, text, false);
});

bot.registerCommandAlias('r', 'reply');

// Anonymous replies only show the role, not the username
bot.registerCommand('anonreply', (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  const text = args.join(' ').trim();
  reply(msg, text, true);
});

bot.registerCommandAlias('ar', 'anonreply');

bot.registerCommand('close', (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  threads.getByChannelId(msg.channel.id).then(thread => {
    if (! thread) return;

    msg.channel.createMessage('Saving logs and closing channel...');
    msg.channel.getMessages(10000).then(messages => {
      const log = messages.reverse().map(msg => {
          const date = moment.utc(msg.timestamp, 'x').format('YYYY-MM-DD HH:mm:ss');
          return `[${date}] ${msg.author.username}#${msg.author.discriminator}: ${msg.content}`;
        }).join('\n') + '\n';

      logs.getNewLogFile(thread.userId).then(logFilename => {
        logs.saveLogFile(logFilename, log)
          .then(() => logs.getLogFileUrl(logFilename))
          .then(url => {
            const closeMessage = `Modmail thread with ${thread.username} (${thread.userId}) was closed by ${msg.author.username}
Logs: <${url}>`;

            bot.createMessage(utils.getModmailGuild(bot).id, closeMessage);
            threads.close(thread.channelId).then(() => msg.channel.delete());
          });
      });
    });
  });
});

bot.registerCommand('block', (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  function block(userId) {
    blocked.block(userId).then(() => {
      msg.channel.createMessage(`Blocked <@${userId}> (id ${userId}) from modmail`);
    });
  }

  if (args.length > 0) {
    const userId = utils.getUserMention(args.join(' '));
    if (! userId) return;
    block(userId);
  } else {
    // Calling !block without args in a modmail thread blocks the user of that thread
    threads.getByChannelId(msg.channel.id).then(thread => {
      if (! thread) return;
      block(thread.userId);
    });
  }
});

bot.registerCommand('unblock', (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  function unblock(userId) {
    blocked.unblock(userId).then(() => {
      msg.channel.createMessage(`Unblocked <@${userId}> (id ${userId}) from modmail`);
    });
  }

  if (args.length > 0) {
    const userId = utils.getUserMention(args.join(' '));
    if (! userId) return;
    unblock(userId);
  } else {
    // Calling !unblock without args in a modmail thread unblocks the user of that thread
    threads.getByChannelId(msg.channel.id).then(thread => {
      if (! thread) return;
      unblock(thread.userId);
    });
  }
});

bot.registerCommand('logs', (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  function getLogs(userId) {
    logs.getLogsWithUrlByUserId(userId).then(infos => {
      let message = `**Log files for <@${userId}>:**\n`;

      message += infos.map(info => {
        const formattedDate = moment.utc(info.date, 'YYYY-MM-DD HH:mm:ss').format('MMM Do [at] HH:mm [UTC]');
        return `\`${formattedDate}\`: <${info.url}>`;
      }).join('\n');

      // Send the list of logs in chunks of 15 lines per message
      const lines = message.split('\n');
      const chunks = utils.chunk(lines, 15);

      let root = Promise.resolve();
      chunks.forEach(lines => {
        root = root.then(() => msg.channel.createMessage(lines.join('\n')));
      });
    });
  }

  if (args.length > 0) {
    const userId = utils.getUserMention(args.join(' '));
    if (! userId) return;
    getLogs(userId);
  } else {
    // Calling !logs without args in a modmail thread returns the logs of the user of that thread
    threads.getByChannelId(msg.channel.id).then(thread => {
      if (! thread) return;
      getLogs(thread.userId);
    });
  }
});

// Snippets
bot.on('messageCreate', async msg => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;
  if (msg.author.bot) return;
  if (! msg.content) return;
  if (! msg.content.startsWith(snippetPrefix)) return;

  const shortcut = msg.content.replace(snippetPrefix, '').toLowerCase();
  const snippet = await snippets.get(shortcut);
  if (! snippet) return;

  reply(msg, snippet.text, snippet.isAnonymous);
});

// Show or add a snippet
bot.registerCommand('snippet', async (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  const shortcut = args[0];
  const text = args.slice(1).join(' ').trim();

  if (! shortcut) return;

  const snippet = await snippets.get(shortcut);
  if (snippet) {
    if (text) {
      // If the snippet exists and we're trying to create a new one, inform the user the snippet already exists
      msg.channel.createMessage(`Snippet "${shortcut}" already exists! You can edit or delete it with ${prefix}edit_snippet and ${prefix}delete_snippet respectively.`);
    } else {
      // If the snippet exists and we're NOT trying to create a new one, show info about the existing snippet
      msg.channel.createMessage(`\`${snippetPrefix}${shortcut}\` replies ${snippet.isAnonymous ? 'anonymously ' : ''}with:\n${snippet.text}`);
    }
  } else {
    if (text) {
      // If the snippet doesn't exist and the user wants to create it, create it
      await snippets.add(shortcut, text, false);
      msg.channel.createMessage(`Snippet "${shortcut}" created!`);
    } else {
      // If the snippet doesn't exist and the user isn't trying to create it, inform them how to create it
      msg.channel.createMessage(`Snippet "${shortcut}" doesn't exist! You can create it with \`${prefix}snippet ${shortcut} text\``);
      return;
    }
  }
});
bot.registerCommandAlias('s', 'snippet');

bot.registerCommand('delete_snippet', async (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  const shortcut = args[0];
  if (! shortcut) return;

  const snippet = await snippets.get(shortcut);
  if (! snippet) {
    msg.channel.createMessage(`Snippet "${shortcut}" doesn't exist!`);
    return;
  }

  await snippets.del(shortcut);
  msg.channel.createMessage(`Snippet "${shortcut}" deleted!`);
});
bot.registerCommandAlias('ds', 'delete_snippet');

bot.registerCommand('edit_snippet', async (msg, args) => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  const shortcut = args[0];
  const text = args.slice(1).join(' ').trim();

  if (! shortcut) return;
  if (! text) return;

  const snippet = await snippets.get(shortcut);
  if (! snippet) {
    msg.channel.createMessage(`Snippet "${shortcut}" doesn't exist!`);
    return;
  }

  await snippets.del(shortcut);
  await snippets.add(shortcut, text, snippet.isAnonymous);

  msg.channel.createMessage(`Snippet "${shortcut}" edited!`);
});
bot.registerCommandAlias('es', 'edit_snippet');

bot.registerCommand('snippets', async msg => {
  if (! msg.channel.guild) return;
  if (msg.channel.guild.id !== utils.getModmailGuild(bot).id) return;
  if (! isStaff(msg.member)) return;

  const allSnippets = await snippets.all();
  const shortcuts = Object.keys(allSnippets);
  shortcuts.sort();

  msg.channel.createMessage(`Available snippets (prefix ${snippetPrefix}):\n${shortcuts.join(', ')}`);
});

bot.connect();
webserver.run();
greeting.init(bot);
