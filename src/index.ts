import "./style.scss"
import { cloneDeep } from "lodash";
import { lerp } from "./math";

const NUM_ENTITIES = 2;
const NUM_PANES = 4;

const SERVER_TICK_DURATION = 1.0 / 20.0;

type Vec2 = { x: number, y: number }
type Entity = {
    position: Vec2,
    speed: number,
    angle: number,
    angularVelocity: number,
    htmlElement: HTMLElement | null,
    rawHtmlElement: HTMLElement | null
}

type Game = {
    entities: Entity[]
}

type Server = {
    game: Game,

    tick: number,
    tickDuration: number,
    tickAccumulator: number
}

type ServerNetMessage = {
    tick: number,
    entityPositions: Vec2[]
}

type ClientInFlightMessage = {
    message: ServerNetMessage,

    /**
     * Time remaining before this message should be processed.
     * (Due to simulated latency and jitter)
     */
    timeRemaining: number
}

type Client = {
    game: Game,
    net: {
        sim: {
            /**
             * Latency (network round-trip time) to server, in milliseconds
             */
            latency: number,

            /**
             * Jitter. Variance in delay between packets, in +- milliseconds
             */
            jitter: number 

            /**
             * Packet loss, ranging from 0.0 (no packets lost) to 1.0 (all
             * packets lost)
             */
            packetLoss: number,

            /**
             * List of in-flight messages waiting to be processed (due to
             * simulated latency and jitter)
             */
            inFlightMessages: ClientInFlightMessage[],
        },

        /**
         * Last received tick from the server
         */
        lastReceivedTick: number,

        /**
         * Network back buffer. 
         */
        backBuffer: ServerNetMessage[],

        /**
         * How far in the past to render. A function of jitter and packet loss
         * (variant network conditions). Measured in ticks.
         */
        interpolationDelay: number
    }

    /**
     * Client clock. This should always be synchronized with the time of server
     * ticks coming in from the network. If latency changes (average of jitter
     * around clock != 0), the clock should be sped up or slowed down to
     * resynchonize with the incoming server clock
     */
    tick: number,
    tickAccumulator: number,

    /** 
     * Client tick duration. Used to speed up and slow down the clock. In ideal
     * conditions (no latency variation), this should match the server tick
     * rate.
     */
    tickDuration: number,

    prevNetState: ServerNetMessage | null,
    nextNetState: ServerNetMessage | null
}

type App = {
    server: Server,
    clients: Client[]
}

const app: App = {
    server: {
        tick: 0,
        tickDuration: SERVER_TICK_DURATION,
        tickAccumulator: 0.0,
        game: { entities: [] }
    },
    clients: []
}

// Expose app state to window (so it's accessible from the browser console)
declare global {
    interface Window { app: App }
}
window.app = app;

function initAppState() {

    // The first pane is the server, the remaining panes are the clients.
    // Initialise client game states for NUM_PANES - 1
    for (let i = 0; i < NUM_PANES - 1; ++i) {
        app.clients.push({
            game: { entities: [] },
            net: {
                sim: {
                    latency: 60.0,
                    jitter: 10.0,
                    packetLoss: 0.1,
                    inFlightMessages: []
                },
                lastReceivedTick: 0,
                backBuffer: [],
                interpolationDelay: 6.0
            },

            tick: 0,
            tickDuration: SERVER_TICK_DURATION,
            tickAccumulator: 0,

            prevNetState: null,
            nextNetState: null
        })
    }

    for (let i = 0; i < NUM_PANES; ++i) {
        for (let j = 0; j < NUM_ENTITIES; ++j) {

            const entity: Entity = {
                position: { x: 0.5, y: 0.5 },
                speed: 0.0,
                angle: 0.0,
                angularVelocity: 0.0,
                htmlElement: null,
                rawHtmlElement: null
            };

            // Only initialise server entities properly.
            // Client entities will be synced over the network.
            if (i === 0) {
                entity.position = {
                    x: Math.random(),
                    y: Math.random()
                };

                entity.speed = Math.random() * 0.2 + 0.1;
                entity.angle = Math.random() * 2 * Math.PI;
                // entity.angularVelocity = Math.random() * 0.01;

                app.server.game.entities.push(entity);
            } else {
                app.clients[i - 1].game.entities.push(entity);
            }

        }
    }
}

function domCreatePanes() {
    for (let i = 0; i < NUM_PANES; ++i) {
        const elPane = document.createElement("div");
        elPane.className = "pane";
        elPane.id = `pane-${i}`;

        const elLabel = document.createElement("div");
        elLabel.className = "label";
        elLabel.innerText = i === 0 ? "Server" : "Client";

        for (let j = 0; j < NUM_ENTITIES; ++j) {

            // Draw two versions of each entity:
            // - One for drawnig the entity as received by the client
            // - One for the interpolated entity after netcode handling
            for (let k = 0; k < 2; ++k) {

                const elEntity = document.createElement("div");
                elEntity.className = "entity";
                if (k === 1) elEntity.className += " raw";

                let color;
                switch (j % 4) {
                    case 0: color  = "red"; break;
                    case 1: color  = "green"; break;
                    case 2: color  = "blue"; break;
                    case 3: color  = "orange"; break;
                    default: color = "black"; break;
                }
                elEntity.style.backgroundColor = color;

                if (i === 0) {
                    if (k === 0) {
                        app.server.game.entities[j].htmlElement = elEntity;
                    } else {
                        app.server.game.entities[j].rawHtmlElement = elEntity;
                    }
                } else {
                    if (k === 0) {
                        app.clients[i - 1].game.entities[j].htmlElement = elEntity;
                    } else {
                        app.clients[i - 1].game.entities[j].rawHtmlElement = elEntity;
                    }
                }

                elPane.append(elEntity);
            }
        }

        elPane.append(elLabel);

        document.getElementById("root")!.append(elPane);
    }
}

function serverTick(dt: number) {
    const serverEntities = app.server.game.entities;

    serverEntities.forEach(entity => {

        if (Math.random() < 0.05) {
            entity.angularVelocity = (2 * Math.random() - 1);
        }

        entity.angle += entity.angularVelocity * dt;

        let velocity: Vec2 = {
            x: Math.cos(entity.angle) * entity.speed,
            y: Math.sin(entity.angle) * entity.speed
        }

        entity.position.x += velocity.x * dt;
        entity.position.y += velocity.y * dt;

        if (entity.position.x > 1.0) {
            entity.position.x = 1.0;
            velocity.x = -Math.abs(velocity.x);
        } else if (entity.position.x < 0.0) {
            entity.position.x = 0.0;
            velocity.x = Math.abs(velocity.x);
        }

        if (entity.position.y > 1.0) {
            entity.position.y = 1.0;
            velocity.y = -Math.abs(velocity.y);
        } else if (entity.position.y < 0.0) {
            entity.position.y = 0.0;
            velocity.y = Math.abs(velocity.y);
        }

        entity.angle = Math.atan2(velocity.y, velocity.x);
        if (entity.angle < 0) {
            entity.angle += 2 * Math.PI;
        }
    });

    app.server.tick++;
}

function serverNetSend() {

    const message: ServerNetMessage = {
        tick: app.server.tick,
        entityPositions: app.server.game.entities.map(e => e.position)
    };

    // Simulate sending data over the network, for each client
    app.clients.forEach(client => {
        // Simulate packet loss
        const shouldDropPacket = Math.random() < client.net.sim.packetLoss;
        if (shouldDropPacket) return;

        const latency = client.net.sim.latency
        const jitter  = (2 * Math.random() - 1) * client.net.sim.jitter;

        const inFlightMessage: ClientInFlightMessage = {
            message: cloneDeep(message),
            timeRemaining: ((latency / 2) + jitter) / 1000.0
        };

        client.net.sim.inFlightMessages.push(inFlightMessage);
    });
}

function onReceiveServerMessage(client: Client, message: ServerNetMessage) {

    // Ignore out-of-order messages. Old messages are no longer relevant,
    // because future network updates should be redundant up to the last
    // acknowledged tick by the client.
    if (message.tick < client.net.lastReceivedTick) {
        return;
    }
    client.net.lastReceivedTick = message.tick;

    // Push the message to the back-buffer
    client.net.backBuffer.push(cloneDeep(message));

    message.entityPositions.forEach((pos, idx) => {

        const elEntity = client.game.entities[idx].rawHtmlElement!;

        const parentWidth  = elEntity.parentElement!.clientWidth;
        const parentHeight = elEntity.parentElement!.clientHeight;

        elEntity.style.transform =
           `translateX(${pos.x * (parentWidth - 20)}px)
            translateY(${pos.y * (parentHeight - 20)}px)`;
    });
}

let lastFrameTime: number = 0;

function frameStep(t: number) {
    const rdt = (t - lastFrameTime) / 1000;
    lastFrameTime = t;

    // Server tick
    app.server.tickAccumulator += rdt;

    let ticked = false;
    while (app.server.tickAccumulator > app.server.tickDuration) {
        app.server.tickAccumulator -= app.server.tickDuration;
        serverTick(app.server.tickDuration);
        ticked = true;
    }

    if (ticked) {
        serverNetSend();
    }

    // Client updates
    app.clients.forEach(client => {
        // Handle received data from the network
        client.net.sim.inFlightMessages =
        client.net.sim.inFlightMessages.filter(inFlightMessage => {
            inFlightMessage.timeRemaining -= rdt;

            if (inFlightMessage.timeRemaining <= 0.0) { 
                onReceiveServerMessage(client, inFlightMessage.message);
                return false;
            }

            return true;
        });

        client.tickAccumulator += rdt;

        while (client.tickAccumulator > client.tickDuration) {
            client.tickAccumulator -= client.tickDuration;
            client.tick++;
        }

        // Reset the client clock if it's fallen too far behind
        if (client.net.backBuffer.length > 0) {
            const mostRecent = client.net.backBuffer[client.net.backBuffer.length - 1];
            if (mostRecent.tick < client.tick) {
                client.tick = mostRecent.tick;
                client.tickAccumulator = 0.0;
            }
        }

        // Find the two network states that enclose our target time, determined
        // by the interpolation delay
        const targetSubTick = client.tick
                                + (client.tickAccumulator / client.tickDuration)
                                - client.net.interpolationDelay;

        // Upper bound. The state that we will be interpolating towards
        const nextNetStateIdx = client.net.backBuffer.findIndex(message =>
            message.tick > targetSubTick
        );

        // Lower bound
        client.prevNetState = nextNetStateIdx > 0 ? 
            client.net.backBuffer[nextNetStateIdx - 1] : null;

        client.nextNetState = client.net.backBuffer[nextNetStateIdx];

        // Remove old unneeded elements from the back buffer
        client.net.backBuffer.splice(0, nextNetStateIdx - 1);
        
        // There's not a suitable next network state. This means we've stopped
        // receiving data from the server for longer than the clock offset
        // period. At this point, you could extrapolate from known data. Many
        // games do this, and it looks like characters running into walls /
        // around in circles etc. In this case, I'm going to do nothing but
        // pause.
        if (client.nextNetState === null) {
            return;
        }

        // There's not a suitable older network state. This will only happen at
        // the beginning of the session when we haven't accumulated enough data
        // from the server yet. Do nothing.
        if (client.prevNetState === null) {
            return;
        }

        const t = targetSubTick;
        const p = client.prevNetState!.tick;
        const n = client.nextNetState!.tick;

        const alpha = 1 - ((n - t) / (n - p));

        client.game.entities.forEach((entity, idx) => {

            const prevPosition = client.prevNetState!.entityPositions[idx];
            const nextPosition = client.nextNetState!.entityPositions[idx];

            const interpolatedPosition: Vec2 = {
                x: lerp(prevPosition.x, nextPosition.x, alpha),
                y: lerp(prevPosition.y, nextPosition.y, alpha)
            };

            entity.position = interpolatedPosition;
        });
    });

    // Draw
    for (let i = 0; i < NUM_PANES; ++i) {

        let game = (i === 0) ?
            app.server.game :
            app.clients[i - 1].game;

        for (let j = 0; j < NUM_ENTITIES; ++j) {

            let entityData = game.entities[j];
            const elEntity = entityData.htmlElement;

            if (elEntity !== null) {
                const parentWidth = elEntity.parentElement!.clientWidth;
                const parentHeight = elEntity.parentElement!.clientHeight;

                elEntity.style.transform = `translateX(${entityData.position.x * (parentWidth - 20)}px)
                                            translateY(${entityData.position.y * (parentHeight - 20)}px)`;
            }
        }
    }
}

function main() {
    initAppState();
    domCreatePanes();

    function animationFrame(t: number) {
        frameStep(t);
        window.requestAnimationFrame(animationFrame);
    }
    requestAnimationFrame(animationFrame);
}

window.addEventListener("load", main);