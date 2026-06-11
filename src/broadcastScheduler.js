const cron = require('node-cron');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class BroadcastScheduler extends EventEmitter {
  constructor(streamManager, configPath) {
    super();
    this.streamManager = streamManager;
    this.configPath = configPath || path.join(__dirname, '../config/schedule.json');
    this.schedule = {
      version: '1.0',
      timezone: 'Europe/Paris',
      defaults: { playlist: 'lofi', video: 'loop.frenchztv.mp4' },
      weeklyGrid: [],
      oneTimeEvents: []
    };
    this.jobs = new Map();
    this.currentEvent = null;
    this.loadSchedule();
  }

  loadSchedule() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const loaded = JSON.parse(data);
        this.schedule = { ...this.schedule, ...loaded };
        logger.info(`Schedule loaded: ${this.schedule.weeklyGrid.length} weekly events, ${this.schedule.oneTimeEvents.length} one-time events`);
      }
    } catch (err) {
      logger.error('Error loading schedule:', err);
    }
    this.scheduleAllEvents();
  }

  saveSchedule() {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.schedule, null, 2));
      return true;
    } catch (err) {
      logger.error('Error saving schedule:', err);
      return false;
    }
  }

  scheduleAllEvents() {
    // Clear existing jobs
    this.jobs.forEach((job, id) => {
      job.stop();
    });
    this.jobs.clear();

    // Schedule weekly events
    for (const event of this.schedule.weeklyGrid) {
      if (event.enabled) {
        this.scheduleWeeklyEvent(event);
      }
    }

    // Schedule one-time events
    for (const event of this.schedule.oneTimeEvents) {
      if (event.enabled) {
        this.scheduleOneTimeEvent(event);
      }
    }

    logger.info(`Scheduled ${this.jobs.size} active jobs`);
  }

  scheduleWeeklyEvent(event) {
    const [hours, minutes] = event.startTime.split(':').map(Number);
    const days = event.dayOfWeek.join(',');
    const cronExpr = `${minutes} ${hours} * * ${days}`;

    try {
      const job = cron.schedule(cronExpr, () => {
        this.triggerEvent(event);
      }, {
        timezone: this.schedule.timezone
      });

      this.jobs.set(event.id, job);
      logger.info(`Scheduled weekly event "${event.name}" at ${event.startTime} on days ${days}`);
    } catch (err) {
      logger.error(`Error scheduling weekly event ${event.id}:`, err);
    }
  }

  scheduleOneTimeEvent(event) {
    const eventDate = new Date(event.datetime);
    const now = new Date();

    if (eventDate <= now) {
      logger.info(`One-time event "${event.name}" is in the past, skipping`);
      return;
    }

    const cronExpr = `${eventDate.getMinutes()} ${eventDate.getHours()} ${eventDate.getDate()} ${eventDate.getMonth() + 1} *`;

    try {
      const job = cron.schedule(cronExpr, () => {
        this.triggerEvent(event);
        // Remove one-time event after execution
        this.removeEvent(event.id);
      }, {
        timezone: this.schedule.timezone
      });

      this.jobs.set(event.id, job);
      logger.info(`Scheduled one-time event "${event.name}" for ${event.datetime}`);
    } catch (err) {
      logger.error(`Error scheduling one-time event ${event.id}:`, err);
    }
  }

  async triggerEvent(event) {
    logger.info(`Triggering event: ${event.name}`);

    if (!this.streamManager.isStreaming) {
      logger.info('Stream not active, skipping event');
      return;
    }

    if (this.currentEvent) {
      logger.info('Another event is already running, skipping');
      return;
    }

    this.currentEvent = event;
    this.emit('event:triggered', event);

    const videoPath = path.join(__dirname, '..', event.videoPath);
    if (!fs.existsSync(videoPath)) {
      logger.error(`Video not found: ${videoPath}`);
      this.currentEvent = null;
      this.emit('event:error', { event, error: 'Video not found' });
      return;
    }

    const returnConfig = {
      playlist: event.returnPlaylist || this.schedule.defaults.playlist,
      video: event.returnVideo || this.schedule.defaults.video
    };

    try {
      await this.streamManager.startProgram(videoPath, returnConfig);
    } catch (err) {
      logger.error('Error starting program:', err);
      this.currentEvent = null;
      this.emit('event:error', { event, error: err.message });
    }
  }

  handleProgramEnd() {
    if (this.currentEvent) {
      logger.info(`Event "${this.currentEvent.name}" ended`);
      this.emit('event:ended', this.currentEvent);
      this.currentEvent = null;
    }
  }

  generateId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  addWeeklyEvent(eventData) {
    const event = {
      id: this.generateId(),
      name: eventData.name || 'New Event',
      dayOfWeek: eventData.dayOfWeek || [1, 2, 3, 4, 5],
      startTime: eventData.startTime || '12:00',
      type: 'scheduled_video',
      videoPath: eventData.videoPath,
      returnPlaylist: eventData.returnPlaylist || this.schedule.defaults.playlist,
      returnVideo: eventData.returnVideo || this.schedule.defaults.video,
      enabled: eventData.enabled !== false,
      priority: eventData.priority || 1,
      createdAt: new Date().toISOString()
    };

    this.schedule.weeklyGrid.push(event);
    this.saveSchedule();

    if (event.enabled) {
      this.scheduleWeeklyEvent(event);
    }

    this.emit('event:added', event);
    return event;
  }

  addOneTimeEvent(eventData) {
    const event = {
      id: this.generateId(),
      name: eventData.name || 'New Event',
      datetime: eventData.datetime,
      type: 'scheduled_video',
      videoPath: eventData.videoPath,
      returnPlaylist: eventData.returnPlaylist || this.schedule.defaults.playlist,
      returnVideo: eventData.returnVideo || this.schedule.defaults.video,
      enabled: eventData.enabled !== false,
      priority: eventData.priority || 10,
      createdAt: new Date().toISOString()
    };

    this.schedule.oneTimeEvents.push(event);
    this.saveSchedule();

    if (event.enabled) {
      this.scheduleOneTimeEvent(event);
    }

    this.emit('event:added', event);
    return event;
  }

  updateEvent(eventId, updates) {
    let event = this.schedule.weeklyGrid.find(e => e.id === eventId);
    let isWeekly = true;

    if (!event) {
      event = this.schedule.oneTimeEvents.find(e => e.id === eventId);
      isWeekly = false;
    }

    if (!event) {
      return null;
    }

    // Stop existing job
    if (this.jobs.has(eventId)) {
      this.jobs.get(eventId).stop();
      this.jobs.delete(eventId);
    }

    // Update event
    Object.assign(event, updates);
    event.updatedAt = new Date().toISOString();

    this.saveSchedule();

    // Reschedule if enabled
    if (event.enabled) {
      if (isWeekly) {
        this.scheduleWeeklyEvent(event);
      } else {
        this.scheduleOneTimeEvent(event);
      }
    }

    this.emit('event:updated', event);
    return event;
  }

  removeEvent(eventId) {
    // Stop job if running
    if (this.jobs.has(eventId)) {
      this.jobs.get(eventId).stop();
      this.jobs.delete(eventId);
    }

    // Remove from weekly grid
    const weeklyIndex = this.schedule.weeklyGrid.findIndex(e => e.id === eventId);
    if (weeklyIndex !== -1) {
      const removed = this.schedule.weeklyGrid.splice(weeklyIndex, 1)[0];
      this.saveSchedule();
      this.emit('event:removed', removed);
      return removed;
    }

    // Remove from one-time events
    const oneTimeIndex = this.schedule.oneTimeEvents.findIndex(e => e.id === eventId);
    if (oneTimeIndex !== -1) {
      const removed = this.schedule.oneTimeEvents.splice(oneTimeIndex, 1)[0];
      this.saveSchedule();
      this.emit('event:removed', removed);
      return removed;
    }

    return null;
  }

  getEvent(eventId) {
    return this.schedule.weeklyGrid.find(e => e.id === eventId)
      || this.schedule.oneTimeEvents.find(e => e.id === eventId);
  }

  getAllEvents() {
    return {
      weeklyGrid: this.schedule.weeklyGrid,
      oneTimeEvents: this.schedule.oneTimeEvents,
      defaults: this.schedule.defaults,
      timezone: this.schedule.timezone
    };
  }

  getUpcomingEvents(hours = 24) {
    const now = new Date();
    const endTime = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const upcoming = [];

    // Check one-time events
    for (const event of this.schedule.oneTimeEvents) {
      if (!event.enabled) continue;
      const eventDate = new Date(event.datetime);
      if (eventDate >= now && eventDate <= endTime) {
        upcoming.push({
          ...event,
          scheduledTime: eventDate,
          eventType: 'one-time'
        });
      }
    }

    // Check weekly events for the next 24 hours
    const dayNames = ['0', '1', '2', '3', '4', '5', '6'];
    for (const event of this.schedule.weeklyGrid) {
      if (!event.enabled) continue;

      for (let dayOffset = 0; dayOffset <= Math.ceil(hours / 24); dayOffset++) {
        const checkDate = new Date(now);
        checkDate.setDate(checkDate.getDate() + dayOffset);
        const dayOfWeek = checkDate.getDay();

        if (event.dayOfWeek.includes(dayOfWeek)) {
          const [hours, minutes] = event.startTime.split(':').map(Number);
          const eventDate = new Date(checkDate);
          eventDate.setHours(hours, minutes, 0, 0);

          if (eventDate >= now && eventDate <= endTime) {
            upcoming.push({
              ...event,
              scheduledTime: eventDate,
              eventType: 'weekly'
            });
          }
        }
      }
    }

    // Sort by scheduled time, then by priority (higher priority first)
    upcoming.sort((a, b) => {
      const timeDiff = a.scheduledTime - b.scheduledTime;
      if (timeDiff !== 0) return timeDiff;
      return (b.priority || 0) - (a.priority || 0);
    });

    return upcoming;
  }

  getCurrentEvent() {
    return this.currentEvent;
  }

  async playNow(eventId) {
    const event = this.getEvent(eventId);
    if (!event) {
      throw new Error('Event not found');
    }
    await this.triggerEvent(event);
    return event;
  }

  updateDefaults(defaults) {
    this.schedule.defaults = { ...this.schedule.defaults, ...defaults };
    this.saveSchedule();
    this.emit('defaults:updated', this.schedule.defaults);
    return this.schedule.defaults;
  }
}

module.exports = BroadcastScheduler;
