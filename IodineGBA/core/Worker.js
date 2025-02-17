"use strict";
/*
 Copyright (C) 2012-2016 Grant Galitz

 Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
importScripts("../includes/TypedArrayShim.js");
importScripts("Cartridge.js");
importScripts("DMA.js");
importScripts("Emulator.js");
importScripts("Graphics.js");
importScripts("RunLoop.js");
importScripts("Memory.js");
importScripts("IRQ.js");
importScripts("JoyPad.js");
importScripts("Serial.js");
importScripts("Sound.js");
importScripts("Timer.js");
importScripts("Wait.js");
importScripts("CPU.js");
importScripts("Saves.js");
importScripts("sound/FIFO.js");
importScripts("sound/Channel1.js");
importScripts("sound/Channel2.js");
importScripts("sound/Channel3.js");
importScripts("sound/Channel4.js");
importScripts("CPU/ARM.js");
importScripts("CPU/THUMB.js");
importScripts("CPU/CPSR.js");
importScripts("graphics/RendererProxy.js");
importScripts("graphics/RendererShim.js");
importScripts("graphics/Renderer.js");
importScripts("graphics/BGTEXT.js");
importScripts("graphics/BG2FrameBuffer.js");
importScripts("graphics/BGMatrix.js");
importScripts("graphics/AffineBG.js");
importScripts("graphics/ColorEffects.js");
importScripts("graphics/Mosaic.js");
importScripts("graphics/OBJ.js");
importScripts("graphics/OBJWindow.js");
importScripts("graphics/Window.js");
importScripts("graphics/Compositor.js");
importScripts("memory/DMA0.js");
importScripts("memory/DMA1.js");
importScripts("memory/DMA2.js");
importScripts("memory/DMA3.js");
importScripts("cartridge/SaveDeterminer.js");
importScripts("cartridge/SRAM.js");
importScripts("cartridge/FLASH.js");
importScripts("cartridge/EEPROM.js");
var Iodine = new GameBoyAdvanceEmulator();
//Save callbacks waiting to be satisfied:
var saveImportPool = [];
//Graphics Buffers:
var gfxBuffers = [getSharedUint8Array(160 * 240 * 3),
  getSharedUint8Array(160 * 240 * 3)];
var gfxCounters = getSharedInt32Array(3);
//Audio Buffers:
var audioBuffer = null;
var audioBufferSize = 0;
var audioBufferSizeMask = 0;
var audioCounters = getSharedInt32Array(3);
//Time Stamp tracking:
var timestamp = getSharedUint32Array(1);
//Pass the shared array buffers:
postMessage({messageID:0, gfxBuffer1:gfxBuffers[0], gfxBuffer2:gfxBuffers[1], gfxCounters:gfxCounters, audioCounters:audioCounters, timestamp:timestamp}, [gfxBuffers[0].buffer, gfxBuffers[1].buffer, gfxCounters.buffer, audioCounters.buffer, timestamp.buffer]);
//Event decoding:
self.onmessage = function (event) {
    var data = event.data;
    switch (data.messageID | 0) {
        case 0:
            try {
                Iodine.play();
            }
            catch (e) {
                postMessage({messageID:9});
            }
            break;
        case 1:
            Iodine.pause();
            break;
        case 2:
            Iodine.restart();
            break;
        case 3:
            Iodine.setIntervalRate(data.payload | 0);
            setInterval(function() {Iodine.timerCallback(timestamp[0] >>> 0);}, data.payload | 0);
            break;
        case 4:
            Iodine.attachGraphicsFrameHandler(graphicsFrameHandler);
            break;
        case 5:
            Iodine.attachAudioHandler(audioHandler);
            break;
        case 6:
            Iodine.enableAudio();
            break;
        case 7:
            Iodine.disableAudio();
            break;
        case 8:
            Iodine.toggleSkipBootROM(!!data.payload);
            break;
        case 9:
            Iodine.toggleDynamicSpeed(!!data.payload);
            break;
        case 10:
            Iodine.attachSpeedHandler(speedHandler);
            break;
        case 11:
            Iodine.keyDown(data.payload | 0);
            break;
        case 12:
            Iodine.keyUp(data.payload | 0);
            break;
        case 13:
            Iodine.incrementSpeed(+data.payload);
            break;
        case 14:
            Iodine.setSpeed(+data.payload);
            break;
        case 15:
            Iodine.attachBIOS(data.payload);
            break;
        case 16:
            Iodine.attachROM(data.payload);
            break;
        case 17:
            Iodine.exportSave();
            break;
        case 18:
            Iodine.attachSaveExportHandler(saveExportHandler);
            break;
        case 19:
            Iodine.attachSaveImportHandler(saveImportHandler);
            break;
        case 20:
            processSaveImportSuccess(data.payload);
            break;
        case 21:
            processSaveImportFail();
            break;
        case 22:
            Iodine.toggleOffthreadGraphics(!!data.payload);
    }
}
var graphicsFrameHandler = {
    //Function only called if graphics is THIS thread:
    copyBuffer:function (swizzledFrame) {
        //Push a frame of graphics to the blitter handle:
        //Load the counter values:
        var start = gfxCounters[0] | 0;                     //Written by the other thread.
        var end = gfxCounters[1] | 0;                       //Written by this thread.
        //Check if buffer is full:
        if ((end | 0) == (((start | 0) + 2) | 0)) {
            //Skip copying a frame out:
            return;
        }
        //Copy samples into the ring buffer:
        //Hardcoded for 2 buffers for a triple buffer effect:
        gfxBuffers[end & 0x1].set(swizzledFrame);
        //Increment the ending position counter by 1:
        //Atomic to commit the counter to memory:
        Atomics.store(gfxCounters, 1, ((end | 0) + 1) | 0);
    }
};
//Shim for our audio api:
var audioHandler = {
    initialize:function (channels, sampleRate, bufferLimit, call1, call2, call3) {
        //Initialize the audio mixer input:
        channels = channels | 0;
        sampleRate = +sampleRate;
        bufferLimit = bufferLimit | 0;
        //Generate an audio buffer:
        audioBufferSize = ((bufferLimit | 0) * (channels | 0)) | 0;
        audioBufferSizeMask = 1;
        while ((audioBufferSize | 0) >= (audioBufferSizeMask | 0)) {
            audioBufferSizeMask = (audioBufferSizeMask << 1) | 1;
        }
        audioBufferSize = ((audioBufferSizeMask | 0) + 1) | 0;
        //Only regen the buffer if we need to make it bigger:
        if (!audioBuffer || (audioBufferSize | 0) > (audioBuffer.length | 0)) {
            audioBuffer = getSharedFloat32Array(audioBufferSize | 0);
            postMessage({messageID:1, audioBuffer:audioBuffer}, [audioBuffer.buffer]);
        }
        postMessage({messageID:2, channels:channels | 0, sampleRate:+sampleRate, bufferLimit:bufferLimit | 0});
    },
    push:function (buffer, startPos, endPos) {
        startPos = startPos | 0;
        endPos = endPos | 0;
        //Push audio to the audio mixer input handle:
        //Load the counter values:
        var start = audioCounters[0] | 0;                 //Written to by the other thread.
        var end = audioCounters[1] | 0;                   //Written by this thread.
        var endCorrected = ((end | 0) & (audioBufferSizeMask | 0)) | 0;
        var freeBufferSpace = ((end | 0) - (start | 0)) | 0;
        freeBufferSpace = ((audioBufferSize | 0) - (freeBufferSpace | 0)) | 0;
        var amountToSend = ((endPos | 0) - (startPos | 0)) | 0;
        amountToSend = Math.min(amountToSend | 0, freeBufferSpace | 0) | 0;
        endPos = ((startPos | 0) + (amountToSend | 0)) | 0;
        //Push audio into buffer:
        for (; (startPos | 0) < (endPos | 0); startPos = ((startPos | 0) + 1) | 0) {
            audioBuffer[endCorrected | 0] = +buffer[startPos | 0];
            endCorrected = ((endCorrected | 0) + 1) | 0;
            if ((endCorrected | 0) == (audioBufferSize | 0)) {
                endCorrected = 0;
            }
        }
        //Update the cross thread buffering count:
        end = ((end | 0) + (amountToSend | 0)) | 0;
        //Atomic store to commit writes to memory:
        Atomics.store(audioCounters, 1, end | 0);
    },
    register:function () {
        //Register into the audio mixer:
        postMessage({messageID:3});
    },
    unregister:function () {
        //Unregister from audio mixer:
        postMessage({messageID:4});
    },
    setBufferSpace:function (spaceContain) {
        //Ensure buffering minimum levels for the audio:
        postMessage({messageID:5, audioBufferContainAmount:spaceContain | 0});
    },
    remainingBuffer:function () {
        //Report the amount of audio samples in-flight:
        var ringBufferCount = this.remainingBufferShared() | 0;
        var audioSysCount = audioCounters[2] | 0;
        return ((ringBufferCount | 0) + (audioSysCount | 0)) | 0;
    },
    remainingBufferShared:function () {
        //Reported the sample count left in the shared buffer:
        var start = audioCounters[0] | 0;
        var end = audioCounters[1] | 0;
        var ringBufferCount = ((end | 0) - (start | 0)) | 0;
        return ringBufferCount | 0;
    }
};
function saveImportHandler(saveID, saveCallback, noSaveCallback) {
    postMessage({messageID:6, saveID:saveID});
    saveImportPool.push([saveCallback, noSaveCallback]);
}
function saveExportHandler(saveID, saveData) {
    postMessage({messageID:7, saveID:saveID, saveData:saveData});
}
function speedHandler(speed) {
    postMessage({messageID:8, speed:speed});
}
function processSaveImportSuccess(saveData) {
    saveImportPool.shift()[0](saveData);
}
function processSaveImportFail() {
    saveImportPool.shift()[1]();
}
