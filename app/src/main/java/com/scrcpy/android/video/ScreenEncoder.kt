package com.scrcpy.android.video

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.util.Log
import android.view.Surface
import kotlinx.coroutines.*
import java.io.DataOutputStream
import java.net.Socket
import java.nio.ByteBuffer

class ScreenEncoder(
    private val mediaProjection: MediaProjection,
    private val socket: Socket
) {
    
    private var mediaCodec: MediaCodec? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var isEncoding = false
    private val scope = CoroutineScope(Dispatchers.Default + Job())
    private var outputStream: DataOutputStream? = null

    companion object {
        private const val TAG = "ScreenEncoder"
        private const val WIDTH = 720
        private const val HEIGHT = 1280
        private const val BIT_RATE = 2000000
        private const val FRAME_RATE = 30
        private const val I_FRAME_INTERVAL = 2
    }

    fun start() {
        scope.launch {
            try {
                Log.d(TAG, "Starting screen encoder...")
                setupEncoder()
                startEncoding()
            } catch (e: Exception) {
                Log.e(TAG, "Encoder error", e)
            }
        }
    }

    private fun setupEncoder() {
        outputStream = DataOutputStream(socket.getOutputStream())
        
        val format = MediaFormat.createVideoFormat(
            MediaFormat.MIMETYPE_VIDEO_AVC,
            WIDTH,
            HEIGHT
        ).apply {
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
            )
            setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
            setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL)
        }

        mediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
            configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }
        
        val surface: Surface = mediaCodec!!.createInputSurface()
        mediaCodec?.start()

        virtualDisplay = mediaProjection.createVirtualDisplay(
            "ScreenCapture",
            WIDTH, HEIGHT, 1,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC,
            surface, null, null
        )
        
        Log.d(TAG, "Encoder setup complete: ${WIDTH}x${HEIGHT}, ${BIT_RATE}bps")
    }

    private fun startEncoding() {
        isEncoding = true
        val bufferInfo = MediaCodec.BufferInfo()
        var configSent = false
        var frameCount = 0

        Log.d(TAG, "Start encoding loop...")

        while (isEncoding) {
            try {
                val outputBufferId = mediaCodec?.dequeueOutputBuffer(bufferInfo, 10000) ?: continue
                
                when (outputBufferId) {
                    MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        val format = mediaCodec?.outputFormat
                        Log.d(TAG, "Output format changed: $format")
                        
                        // 发送配置帧（SPS/PPS）
                        val csd0 = format?.getByteBuffer("csd-0")
                        val csd1 = format?.getByteBuffer("csd-1")
                        
                        if (csd0 != null && csd1 != null) {
                            val configData = ByteArray(csd0.remaining() + csd1.remaining())
                            csd0.get(configData, 0, csd0.remaining())
                            csd1.get(configData, csd0.limit(), csd1.remaining())
                            
                            sendFrame(configData, 0, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
                            configSent = true
                            Log.d(TAG, "Config frame sent: ${configData.size} bytes")
                        }
                    }
                    
                    in 0..Int.MAX_VALUE -> {
                        val outputBuffer = mediaCodec?.getOutputBuffer(outputBufferId)
                        
                        if (outputBuffer != null && bufferInfo.size > 0) {
                            // 只有在配置帧发送后才发送数据帧
                            if (configSent || (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                val data = ByteArray(bufferInfo.size)
                                outputBuffer.position(bufferInfo.offset)
                                outputBuffer.get(data)
                                
                                sendFrame(data, bufferInfo.presentationTimeUs, bufferInfo.flags)
                                
                                frameCount++
                                if (frameCount % 30 == 0) {
                                    Log.d(TAG, "Encoded $frameCount frames")
                                }
                            }
                        }
                        
                        mediaCodec?.releaseOutputBuffer(outputBufferId, false)
                        
                        // 检查是否结束
                        if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            Log.d(TAG, "End of stream")
                            break
                        }
                    }
                }
                
            } catch (e: Exception) {
                Log.e(TAG, "Encoding error", e)
                break
            }
        }
        
        Log.d(TAG, "Encoding stopped, total frames: $frameCount")
    }

    private fun sendFrame(data: ByteArray, timestamp: Long, flags: Int) {
        try {
            // 发送数据包：4字节长度 + 8字节时间戳 + 4字节标志 + 数据
            outputStream?.writeInt(data.size)
            outputStream?.writeLong(timestamp)
            outputStream?.writeInt(flags)
            outputStream?.write(data)
            outputStream?.flush()
        } catch (e: Exception) {
            Log.e(TAG, "Send frame error", e)
            throw e
        }
    }

    fun stop() {
        isEncoding = false
        try {
            virtualDisplay?.release()
            mediaCodec?.stop()
            mediaCodec?.release()
            outputStream?.close()
            Log.d(TAG, "Encoder stopped")
        } catch (e: Exception) {
            Log.e(TAG, "Stop error", e)
        }
        scope.cancel()
    }
}
