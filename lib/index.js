// es6 runtime requirements
import pkg from 'body-parser'
import cors from 'cors'
import remail from 'email-regex'
// their code
import express from 'express'
import { HOSTNAME } from 'hostenv'
import { Server as http } from 'http'
import { dirname } from 'path'
import { Server } from 'socket.io'
import request from 'superagent'
import { fileURLToPath } from 'url'
import dom from 'vd'
import badge from './badge.js'
import iframe from './iframe.js'
import log from './log.js'
import invite from './slack-invite.js'
// our code
import Slack from './slack.js'
import splash from './splash.js'
const { json } = pkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default function slackin({
    token,
    interval = 5000, // jshint ignore:line
    org,
    gcaptcha_secret,
    gcaptcha_sitekey,
    css,
    coc,
    cors: useCors = false,
    path = '/',
    channels,
    emails,
    silent = false, // jshint ignore:line,
}) {
    // must haves
    if (!token) throw new Error('Must provide a `token`.')
    if (!org) throw new Error('Must provide an `org`.')
    if (!gcaptcha_secret) throw new Error('Must provide a `gcaptcha_secret`.')
    if (!gcaptcha_sitekey)
        throw new Error('Must provide an `gcaptcha_sitekey`.')

    if (channels) {
        // convert to an array
        channels = channels.split(',').map((channel) => {
            // sanitize channel name
            if ('#' === channel[0]) return channel.substr(1)
            return channel
        })
    }

    if (emails) {
        // convert to an array
        emails = emails.split(',')
    }

    // setup app
    let app = express()
    let srv = http(app)
    srv.app = app

    let assets = __dirname + '/assets'

    // fetch data
    let slack = new Slack({ token, interval, org })

    slack.setMaxListeners(Infinity)

    // capture stats
    log(slack, silent)

    // middleware for waiting for slack
    app.use((req, res, next) => {
        if (slack.ready) return next()
        slack.once('ready', next)
    })

    if (useCors) {
        app.options('*', cors())
        app.use(cors())
    }

    // splash page
    app.get('/', (req, res) => {
        let { name, logo } = slack.org
        let { active, total } = slack.users
        if (!name) return res.send(404)
        let page = dom(
            'html',
            dom(
                'head',
                dom('title', 'Join ', name, ' on Slack!'),
                dom('script src=https://www.google.com/recaptcha/api.js'),
                dom(
                    'meta name=viewport content="width=device-width,initial-scale=1.0,minimum-scale=1.0,user-scalable=no"'
                ),
                dom(
                    'link rel="shortcut icon" href=https://slack.global.ssl.fastly.net/272a/img/icons/favicon-32.png'
                ),
                css && dom('link rel=stylesheet', { href: css })
            ),
            splash({
                coc,
                path,
                css,
                name,
                org,
                logo,
                channels,
                active,
                total,
                gcaptcha_sitekey,
            })
        )
        res.type('html')
        res.send(page.toHTML())
    })

    app.get('/data', (req, res) => {
        let { name, logo } = slack.org
        let { active, total } = slack.users
        res.send({
            name,
            org,
            coc,
            logo,
            channels,
            active,
            total,
        })
    })

    // static files
    app.use('/assets', express.static(assets))

    // invite endpoint
    app.post('/invite', json(), (req, res, next) => {
        let chanId
        if (channels) {
            let channel = req.body.channel
            if (!channels.includes(channel)) {
                return res.status(400).json({ msg: 'Not a permitted channel' })
            }
            chanId = slack.getChannelId(channel)
            if (!chanId) {
                return res
                    .status(400)
                    .json({ msg: `Channel not found "${channel}"` })
            }
        }

        let email = req.body.email
        let captcha_response = req.body['g-recaptcha-response']

        if (!email) {
            return res.status(400).json({ msg: 'No email provided' })
        }

        if (captcha_response == undefined || !captcha_response.length) {
            return res.status(400).send({ msg: 'Invalid captcha' })
        }

        if (!remail().test(email)) {
            return res.status(400).json({ msg: 'Invalid email' })
        }

        // Restricting email invites?
        if (emails && emails.indexOf(email) === -1) {
            return res
                .status(400)
                .json({ msg: 'Your email is not on the accepted email list' })
        }

        if (coc && '1' != req.body.coc) {
            return res
                .status(400)
                .json({ msg: 'Agreement to CoC is mandatory' })
        }

        /////////////////////////////////////////////////////////////////////////

        const captcha_data = {
            secret: gcaptcha_secret,
            response: captcha_response,
            remoteip: req.connection.remoteAddress,
        }

        const captcha_callback = (err, resp) => {
            if (err) {
                return res.status(400).send({ msg: err })
            } else {
                if (resp.body.success) {
                    let chanId = slack.channel ? slack.channel.id : null

                    invite({ token, org, email, channel: chanId }, (err) => {
                        if (err) {
                            if (err.message === `Sending you to Slack...`) {
                                return res.status(303).json({
                                    msg: err.message,
                                    redirectUrl: `https://${org}.slack.com`,
                                })
                            }

                            return res.status(400).json({ msg: err.message })
                        }

                        res.status(200).json({ msg: 'WOOT. Check your email!' })
                    })
                } else {
                    if (err) {
                        return res
                            .status(400)
                            .send({ msg: 'Captcha check failed' })
                    }
                }
            }
        }

        request
            .post('https://www.google.com/recaptcha/api/siteverify')
            .type('form')
            .send(captcha_data)
            .end(captcha_callback)
    })

    // iframe
    app.get('/iframe', (req, res) => {
        let large = 'large' in req.query
        let { active, total } = slack.users
        res.type('html')
        res.send(iframe({ path, active, total, large }).toHTML())
    })

    app.get('/iframe/dialog', (req, res) => {
        let large = 'large' in req.query
        let { name } = slack.org
        let { active, total } = slack.users
        if (!name) return res.send(404)
        let page = dom(
            'html',
            dom('script src=https://www.google.com/recaptcha/api.js'),
            splash({
                coc,
                path,
                name,
                org,
                channels,
                active,
                total,
                large,
                iframe: true,
                gcaptcha_sitekey,
            })
        )
        res.type('html')
        res.send(page.toHTML())
    })

    app.get('/.well-known/acme-challenge/:id', (req, res) => {
        res.send(process.env.LETSENCRYPT_CHALLENGE)
    })

    // badge js
    app.use('/slackin.js', express.static(assets + '/badge.js'))

    // badge rendering
    app.get('/badge.svg', (req, res) => {
        res.type('svg')
        res.set('Cache-Control', 'max-age=0, no-cache')
        res.set('Pragma', 'no-cache')
        res.send(badge(slack.users).toHTML())
    })

    // realtime
    new Server(srv).on('connection', (socket) => {
        socket.emit('data', slack.users)
        let change = (key, val) => socket.emit(key, val)
        slack.on('change', change)
        socket.on('disconnect', () => {
            slack.removeListener('change', change)
        })
    })

    return srv
}

const port = process.env.PORT
const hostname = process.env.WEBSITE_HOSTNAME || HOSTNAME || '0.0.0.0'

const coc = process.env.SLACK_COC
const channels = process.env.SLACK_CHANNELS
const org = process.env.SLACK_SUBDOMAIN
const token = process.env.SLACK_API_TOKEN
const emails = process.env.EMAIL_SLACK_LIST || ''
const interval = process.env.SLACK_INTERVAL

const gcaptcha_secret = process.env.GOOGLE_CAPTCHA_SECRET
const gcaptcha_sitekey = process.env.GOOGLE_CAPTCHA_SITEKEY

slackin({
    token: token,
    interval: interval,
    org: org,
    gcaptcha_secret: gcaptcha_secret,
    gcaptcha_sitekey: gcaptcha_sitekey,
    coc: true,
    cors: true,
    path: '/slackin',
    channels: channels,
    emails: emails,
    silent: false,
}).listen(port, hostname, function (err) {
    if (err) throw err
    console.log('%s – listening on %s:%d', new Date(), hostname, port)
})
