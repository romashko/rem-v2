/**
 * Created by Julian/Wolke on 01.11.2016.
 */
//uwu
global.Promise = require('bluebird');
const config = require('../config/main.json');
global.remConfig = config;
let useCrystal = false;
let Crystal;
// try {
//     Crystal = require("eris-crystal");
//     useCrystal = true;
// } catch (e) {
//
// }
const Eris = require('eris');
let StatsD = require('hot-shots');
let dogstatsd = new StatsD();
const EventEmitter = require('eventemitter3');
const guildModel = require('./DB/guild');
let winston = require('winston');
let raven = require('raven');
let mongoose = require('mongoose');
let url = config.beta ? 'mongodb://localhost/discordbot-beta' : 'mongodb://localhost/discordbot';
let Connector = require('./structures/connector');
let ModuleManager = require('./modules/moduleManager');
mongoose.Promise = Promise;
mongoose.connect(url, (err) => {
    if (err) return winston.error('Failed to connect to the database!');
});
let stat = config.beta ? 'rem-beta' : 'rem-live';
let blocked = require('blocked');
let version = require('./../package.json').version;
let Raven = require('raven');
if (!config.no_error_tracking) {
    Raven.config(config.sentry_token, {
        release: version,
        environment: config.environment
    }).install(() => {
        winston.error('Oh no I died!');
        process.exit(1);
    });
}
/**
 * The base shard class
 * @extends EventEmitter
 */
class Shard extends EventEmitter {
    /**
     * The constructor
     * @constructor
     * @param SHARD_ID The shardid of the bot
     * @param SHARD_COUNT the max shardcount
     * @param hub the clusterhub instance used to send data back and forth
     */
    constructor(SHARD_ID, SHARD_COUNT, hub) {
        super();
        this.id = SHARD_ID;
        this.count = SHARD_COUNT;
        this.bot = null;
        this.ready = false;
        this.CON = new Connector();
        this.MSG = null;
        this.HUB = hub;
        this.MOD = new ModuleManager();
        this.GM = null;
        this.UM = null;
        this.interval = null;
        this.init();
    }

    /**
     * Setup a listener if the eventloop blocks,
     * then call the initClient method
     */
    init() {
        blocked((ms) => {
            console.log('Shard:' + this.id + ' BLOCKED FOR %sms', ms | 0);
        });
        this.initClient();
    }

    /**
     * Initiates the Client and Eris
     * In this function Rem sets up listeners for common events, configures eris and starts the lib
     */
    initClient() {
        let options = {
            autoreconnect: true,
            compress: true,
            messageLimit: 200,
            disableEveryone: true,
            getAllUsers: true,
            firstShardID: parseInt(this.id),
            lastShardID: parseInt(this.id),
            maxShards: parseInt(this.count),
            crystal: useCrystal,
            disableEvents: ['typingStart', 'typingStop', 'guildMemberSpeaking', 'messageUpdate']
        };
        winston.info(options);
        let bot = new Eris(config.token, options);
        if (useCrystal) {
            bot.voiceConnections = new Crystal.ErisClient({host: config.crystal_host});
        }
        this.bot = bot;
        global.rem = bot;
        bot.on('ready', () => {
            bot.editStatus('online', {name: '!w.help for commands'});
            this.clientReady();
        });
        bot.on('messageCreate', (msg) => {
            dogstatsd.increment(`${stat}.messages`);
            msg.CON = this.CON;
            this.message(msg);
        });
        bot.on('guildCreate', (Guild) => {
            this.guildCreate(Guild);
        });
        bot.on('guildDelete', (Guild) => {
            this.guildDelete(Guild);
        });
        bot.on('voiceChannelJoin', (m, n) => {
            this.voiceUpdate(m, n, false);
        });
        bot.on('voiceChannelLeave', (m, o) => {
            this.voiceUpdate(m, o, true);
        });
        bot.on('guildMemberAdd', (g, m) => {
            this.guildMemberAdd(g, m);
        });
        bot.on('guildMemberRemove', (g, m) => {
            this.guildMemberRemove(g, m);
        });
        // bot.on('debug', this.debug);
        // bot.on('warn', this.warn);
        bot.on('error', this.error);
        process.on('SIGINT', () => {
            this.shutdown();
        });
        bot.connect();
    }

    /**
     * Here comes the really interesting stuff.
     * 1. Rem starts the init function of the Module Loader, which loads all mods inside /managed
     * 2. Once the modloader is done, rem gets the needed mods and sets them as instancevariables
     * 3. Then some event listeners are setup, which are later used for cache-syncing
     * 4. Rem logs that the commands are ready.
     * 5. Now, Rem sends an initial data update to the main process to update the guild/user counts if necessary.
     * 6. A Interval gets created to update data every 5 mins
     */
    clientReady() {
        this.MOD.init(this.HUB, Raven).then(() => {
            this.ready = true;
            this.MSG = this.MOD.getMod('mm');
            this.GM = this.MOD.getMod('gm');
            this.UM = this.MOD.getMod('um');
            this.SM = this.MOD.getMod('sm');
            this.UM.on('_cache_update', (data) => {
                this.emitCacheUpdate(data);
            });
            this.GM.on('_cache_update', (data) => {
                this.emitCacheUpdate(data);
            });
            this.SM.on('_cache_update', (data) => {
                this.updateLocalCache(data);
            });
            this.HUB.on('_cache_update', (data) => {
                this.updateLocalCache(data);
            });
            this.HUB.on('request_data_master', (event) => {
                this.hubAction(event);
            });
            winston.info('commands are ready!');
            this.sendStats();
            this.createInterval();
        });
        // this.LANG = new LanguageManager();
        // this.VOICE = new VoiceManager();
        // this.MSG = new MsgManager(this.LANG, this.VOICE);
        // this.MSG.on('ready', (cmds) => {
        //     this.ready = true;
        //     this.HUB.emit('_guild_update', this.id, this.bot.guilds.size);
        //     this.HUB.emit('_user_update', this.id, this.bot.guilds.map(g => g.memberCount).reduce((a, b) => a + b));
        //     winston.info('commands are ready!');
        //     this.sendStats();
        //     this.createInterval();
        //     // console.log(cmds);
        // });
    }

    message(msg) {
        if (this.ready && !msg.author.bot) {
            this.CON.invokeAllCollectors(msg);
            this.MSG.check(msg);
        }
    }

    guildCreate(Guild) {
        this.sendStats();
        guildModel.findOne({id: Guild.id}, (err, guild) => {
            if (err) {
                Raven.captureError(err);
                return winston.error(err);
            }
            if (guild) {

            } else {
                let guild = new guildModel({
                    id: Guild.id,
                    nsfwChannels: [],
                    cmdChannels: [],
                    lastVoiceChannel: '',
                    levelEnabled: true,
                    pmNotifications: true,
                    chNotifications: false,
                    prefix: '!w.',
                    lng: 'en'
                });
                guild.save((err) => {
                    if (err) return winston.error(err);
                });
            }
        });
    }

    guildDelete(Guild) {
        this.sendStats();
    }

    guildMemberAdd(member) {

    }

    guildMemberRemove(member) {

    }

    voiceUpdate(member, channel, leave) {
        // if (!leave) {
        //     console.log('user joined voice!');
        // } else {
        //     console.log('user left voice!');
        // }
    }

    debug(info) {
        console.log(info);
    }

    warn(info) {
        winston.warn(info);
    }

    error(err) {
        winston.error(err);
    }

    shutdown() {
        clearInterval(this.interval);
        mongoose.connection.close();
        try {
            this.bot.disconnect();
        } catch (e) {
            console.log(e);
        }
        setTimeout(() => {
            process.exit(0);
        }, 200);
    }

    createInterval() {
        this.interval = setInterval(() => {
            this.sendStats();
        }, 1000 * 120);
    }

    sendStats() {
        this.HUB.emitRemote('_guild_update', {sid: this.id, data: this.bot.guilds.size});
        this.HUB.emitRemote('_user_update', {
            sid: this.id,
            data: this.bot.guilds.map(g => g.memberCount).reduce((a, b) => a + b)
        });
    }

    updateLocalCache({type, data}) {
        switch (type) {
            case 'user':
                this.MOD.getMod('um').updateCache(data);
                return;
            case 'guild':
                this.MOD.getMod('gm').updateCache(data);
                return;
            case 'setting':
                this.MOD.getMod('sm').updateCache(data);
                return;
            default:
                return;
        }
    }

    emitCacheUpdate({type, data}) {
        this.HUB.emitRemote('_cache_update', {shard: this.id, type, data});
    }

    hubAction(event) {
        switch (event.action) {
            case 'bot_info': {
                let data = {
                    users: this.bot.guilds.map(g => g.memberCount).reduce((a, b) => a + b),
                    guilds: this.bot.guilds.size,
                    channels: this.bot.guilds.map(g => g.channels.size).reduce((a, b) => a + b),
                    voice: Object.keys(this.bot.voiceConnections.guilds).length,
                    voice_playing: Object.values(this.bot.voiceConnections.guilds).filter(conn => conn.playing).length
                };
                this.resolveAction(event, data);
                return;
            }
            case 'user_info_id': {
                let user = this.bot.users.find(u => u.id === event.user_id);
                if (user) {
                    user.found = true;
                    this.resolveAction(event, user);
                } else {
                    this.resolveAction(event, {found: false});
                }
                return;
            }
            case 'guild_info_id': {
                let guild = this.bot.guilds.find(g => g.id === event.guild_id);
                if (guild) {
                    guild.found = true;
                    this.resolveAction(event, this.simplifyGuildData(guild));
                } else {
                    this.resolveAction(event, {found: false});
                }
                return;
            }
            case 'shard_info': {
                this.resolveAction(event, {uwu: 'uwu'});
                return;
            }
        }
    }

    simplifyGuildData(guild) {
        let owner = guild.members.find(m => m.id === guild.ownerID).user;
        return {
            id: guild.id,
            name: guild.name,
            region: guild.region,
            ownerID: guild.ownerID,
            iconURL: guild.iconURL,
            found: true,
            memberCount: guild.memberCount,
            sid: guild.shard.id,
            joinedAt: guild.joinedAt,
            createdAt: guild.createdAt,
            owner: owner
        };
    }

    resolveAction(event, data) {
        try {
            this.HUB.emitRemote(`resolve_data_master_${event.id}`, {
                sid: this.id,
                responseDate: Date.now(),
                data: data
            });
        } catch (e) {
            console.log(e);
        }
    }

}
module.exports = Shard;
