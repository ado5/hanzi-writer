const HanziWriterRenderer = require('./renderers/HanziWriterRenderer');
const StateManager = require('./StateManager');
const Point = require('./models/Point');
const CharDataParser = require('./CharDataParser');
const Positioner = require('./Positioner');
const Quiz = require('./Quiz');
const svg = require('./svg');
const defaultCharDataLoader = require('./defaultCharDataLoader');
const Animator = require('./Animator');
const LoadingManager = require('./LoadingManager');
const { assign, isMSBrowser, timeout } = require('./utils');


const defaultOptions = {
  charDataLoader: defaultCharDataLoader,
  onLoadCharDataError: null,
  onLoadCharDataSuccess: null,
  showOutline: true,
  showCharacter: true,

  // positioning options

  width: null,
  height: null,
  padding: 20,

  // animation options

  strokeAnimationSpeed: 1,
  strokeFadeDuration: 400,
  strokeHighlightDuration: 200,
  strokeHighlightSpeed: 2,
  delayBetweenStrokes: 1000,
  delayBetweenLoops: 2000,

  // colors

  strokeColor: '#555',
  radicalColor: null,
  highlightColor: '#AAF',
  outlineColor: '#DDD',
  drawingColor: '#333',

  // quiz options

  showHintAfterMisses: 3,
  highlightOnComplete: true,

  // undocumented obscure options

  drawingFadeDuration: 300,
  drawingWidth: 4,
  strokeWidth: 2,
  outlineWidth: 2,
  // MS browsers are terrible and can't handle masks using paths with stroke
  usePolygonMasks: isMSBrowser(),
};

function HanziWriter(element, character, options = {}) {
  this._animator = new Animator();
  this._canvas = svg.Canvas.init(element);
  this._options = this._assignOptions(options);
  this._loadingManager = new LoadingManager(this._options);
  this.setCharacter(character);
  this._setupListeners();
  this._quiz = null;
}

// ------ public API ------ //

HanziWriter.prototype.showCharacter = function(options = {}) {
  return this._animateWithData(animation => this._characterRenderer.show(animation), options);
};
HanziWriter.prototype.hideCharacter = function(options = {}) {
  return this._animateWithData(animation => this._characterRenderer.hide(animation), options);
};
HanziWriter.prototype.animateCharacter = function(options = {}) {
  this.cancelQuiz();
  return this._animateWithData(animation => this._characterRenderer.animate(animation), options);
};
HanziWriter.prototype.loopCharacterAnimation = function(options = {}) {
  const animateForever = (animation) => {
    if (!animation.isActive()) return null;
    const cascadedOpts = assign({}, this._options, options);
    const delayBetweenLoops = cascadedOpts.delayBetweenLoops;
    const animatePromise = this._characterRenderer.animate(animation);
    if (!animatePromise) return null;
    return animatePromise
      .then(() => timeout(delayBetweenLoops))
      .then(() => animateForever(animation));
  };

  this.cancelQuiz();
  return this._animateWithData(animateForever, options);
};

HanziWriter.prototype.showOutline = function(options = {}) {
  return this._animateWithData(animation => this._outlineRenderer.show(animation), options);
};
HanziWriter.prototype.hideOutline = function(options = {}) {
  return this._animateWithData(animation => this._outlineRenderer.hide(animation), options);
};

HanziWriter.prototype.quiz = function(quizOptions = {}) {
  this._withData(() => {
    this.cancelQuiz();
    this._quiz = new Quiz({
      canvas: this._subCanvas,
      animator: this._animator,
      character: this._character,
      characterRenderer: this._characterRenderer,
      highlightRenderer: this._highlightRenderer,
      quizOptions: assign({}, this._options, quizOptions),
      userStrokeOptions: this._userStrokeOptions,
    });
  });
};

HanziWriter.prototype.cancelQuiz = function() {
  if (this._quiz) this._quiz.cancel();
  this._quiz = null;
};

HanziWriter.prototype.setCharacter = function(char) {
  this.cancelQuiz();
  this._char = char;
  this._animator.cancel();
  if (this._hanziWriterRenderer) this._hanziWriterRenderer.destroy();
  this._hanziWriterRenderer = null;
  this._withDataPromise = this._loadingManager.loadCharData(char).then(pathStrings => {
    if (this._loadingManager.loadingFailed) return;

    const charDataParser = new CharDataParser();
    this._character = charDataParser.generateCharacter(char, pathStrings);
    this._positioner = new Positioner(this._character, this._options);
    this._hanziWriterRenderer = new HanziWriterRenderer(this._character, this._positioner);
    this._stateManager = new StateManager(this._character, this._options);
    this._hanziWriterRenderer.mount(this._canvas, this._stateManager.state);
    this._hanziWriterRenderer.render(this._stateManager.state);
  });
  return this._withDataPromise;
};

// ------------- //

HanziWriter.prototype._assignOptions = function(options) {
  const mergedOptions = assign({}, defaultOptions, options);

  // backfill strokeAnimationSpeed if deprecated strokeAnimationDuration is provided instead
  if (options.strokeAnimationDuration && !options.strokeAnimationSpeed) {
    mergedOptions.strokeAnimationSpeed = 500 / mergedOptions.strokeAnimationDuration;
  }
  if (options.strokeHighlightDuration && !options.strokeHighlightSpeed) {
    mergedOptions.strokeHighlightSpeed = 500 / mergedOptions.strokeHighlightDuration;
  }

  return this._fillWidthAndHeight(mergedOptions);
};

// returns a new options object with width and height filled in if missing
HanziWriter.prototype._fillWidthAndHeight = function(options) {
  const filledOpts = assign({}, options);
  if (filledOpts.width && !filledOpts.height) {
    filledOpts.height = filledOpts.width;
  } else if (filledOpts.height && !filledOpts.width) {
    filledOpts.width = filledOpts.height;
  } else if (!filledOpts.width && !filledOpts.height) {
    const { width, height } = this._canvas.svg.getBoundingClientRect();
    const minDim = Math.min(width, height);
    filledOpts.width = minDim;
    filledOpts.height = minDim;
  }
  return filledOpts;
};

HanziWriter.prototype._withData = function(func) {
  // if this._loadingManager.loadingFailed, then loading failed before this method was called
  // Try reloading again and see if it helps
  if (this._loadingManager.loadingFailed) {
    this.setCharacter(this._char);
    return Promise.resolve().then(() => {
      // check loadingFailed again just in case setCharacter fails synchronously
      if (!this._loadingManager.loadingFailed) {
        return this._withData(func);
      }
    });
  }
  return this._withDataPromise.then(() => {
    if (!this._loadingManager.loadingFailed) {
      return func();
    }
  });
};

HanziWriter.prototype._setupListeners = function() {
  this._canvas.svg.addEventListener('mousedown', (evt) => {
    if (this.isLoadingCharData || !this._quiz) return;
    evt.preventDefault();
    this._forwardToQuiz('startUserStroke', this._getMousePoint(evt));
  });
  this._canvas.svg.addEventListener('touchstart', (evt) => {
    if (this.isLoadingCharData || !this._quiz) return;
    evt.preventDefault();
    this._forwardToQuiz('startUserStroke', this._getTouchPoint(evt));
  });
  this._canvas.svg.addEventListener('mousemove', (evt) => {
    if (this.isLoadingCharData || !this._quiz) return;
    evt.preventDefault();
    this._forwardToQuiz('continueUserStroke', this._getMousePoint(evt));
  });
  this._canvas.svg.addEventListener('touchmove', (evt) => {
    if (this.isLoadingCharData || !this._quiz) return;
    evt.preventDefault();
    this._forwardToQuiz('continueUserStroke', this._getTouchPoint(evt));
  });

  // TODO: fix
  global.document.addEventListener('mouseup', () => this._forwardToQuiz('endUserStroke'));
  global.document.addEventListener('touchend', () => this._forwardToQuiz('endUserStroke'));
};

HanziWriter.prototype._forwardToQuiz = function(method, ...args) {
  if (!this._quiz) return;
  this._quiz[method](...args);
};

HanziWriter.prototype._getMousePoint = function(evt) {
  const box = this._canvas.svg.getBoundingClientRect();
  return this._positioner.convertExternalPoint(new Point(evt.clientX - box.left, evt.clientY - box.top));
};

HanziWriter.prototype._getTouchPoint = function(evt) {
  const box = this._canvas.svg.getBoundingClientRect();
  const x = evt.touches[0].clientX - box.left;
  const y = evt.touches[0].clientY - box.top;
  return this._positioner.convertExternalPoint(new Point(x, y));
};

HanziWriter.prototype._animate = function(func, options = {}) {
  return this._animator.animate(func, options);
};

HanziWriter.prototype._animateWithData = function(func, options = {}) {
  return this._withData(() => this._animate(func, options));
};

// set up window.HanziWriter if we're in the browser
if (typeof global.window !== 'undefined') {
  // store whatever used to be called HanziWriter in case of a conflict
  const previousHanziWriter = global.window.HanziWriter;

  // add a jQuery-esque noConflict method to restore the previous global.window.HanziWriter if necessary
  HanziWriter.noConflict = () => {
    global.window.HanziWriter = previousHanziWriter;
    return HanziWriter;
  };

  global.window.HanziWriter = HanziWriter;
}

// set up module.exports if we're in node/webpack
if (typeof module !== 'undefined') {
  module.exports = HanziWriter;
}
