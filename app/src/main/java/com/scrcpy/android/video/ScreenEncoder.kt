package com.scrcpy.android.video

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.view.Surface
import kotlinx.coroutines.*
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

    companion object {
        private const val WIDTH = 720
        private const val HEIGHT = 1280
        private const val BIT_RATE = 2000000
        private const val FRAME_RATE = 30
        private const val I_FRAME_INTERVAL = 2
    }

    fun start() {
        scope.launch {
            try {
                setupEncoder()
                startEncoding()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun setupEncoder() {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT)
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        format.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
        format.setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE)
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL)

        mediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        mediaCodec?.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        
        val surface = mediaCodec?.createInputSurface()
        mediaCodec?.start()

        virtualDisplay = mediaProjection.createVirtualDisplay(
            "ScreenCapture",
            WIDTH, HEIGHT, 1,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC,
            surface, null, null
        )
    }

    private fun startEncoding() {
        isEncoding = true
        val bufferInfo = MediaCodec.BufferInfo()
        val outputStream = socket.getOutputStream()

        while (isEncoding) {
            try {
                val outputBufferId = mediaCodec?.dequeueOutputBuffer(bufferInfo, 10000) ?: continue
                
                if (outputBufferId >= 0) {
                    val outputBuffer = mediaCodec?.getOutputBuffer(outputBufferId)
                    
                    if (outputBuffer != null && bufferInfo.size > 0) {
                        // 发送数据大小（4字节）
                        val sizeBytes = ByteBuffer.allocate(4).putInt(bufferInfo.size).array()
                        outputStream.write(sizeBytes)
                        
                        // 发送视频数据
                        val data = ByteArray(bufferInfo.size)
                        outputBuffer.get(data)
                        outputStream.write(data)
                        outputStream.flush()
                    }
                    
                    mediaCodec?.releaseOutputBuffer(outputBufferId, false)
                }
                
            } catch (e: Exception) {
                e.printStackTrace()
                break
            }
        }
    }

    fun stop() {
        isEncoding = false
        virtualDisplay?.release()
        mediaCodec?.stop()
        mediaCodec?.release()
        scope.cancel()
    }
}
