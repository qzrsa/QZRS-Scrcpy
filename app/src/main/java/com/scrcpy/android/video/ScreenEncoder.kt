package com.scrcpy.android.video

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.util.Log
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
        private const val TAG = "ScreenEncoder"
        private const val WIDTH = 720
        private const val HEIGHT = 1280
        private const val BIT_RATE = 4000000
        private const val FRAME_RATE = 30
        private const val I_FRAME_INTERVAL = 1
    }

    fun start() {
        scope.launch {
            try {
                setupEncoder()
                startEncoding()
            } catch (e: Exception) {
                Log.e(TAG, "Encoding error", e)
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
        
        Log.d(TAG, "Encoder setup complete")
    }

    private fun startEncoding() {
        isEncoding = true
        val bufferInfo = MediaCodec.BufferInfo()
        val outputStream = socket.getOutputStream()
        
        Log.d(TAG, "Start encoding...")

        while (isEncoding) {
            try {
                val outputBufferId = mediaCodec?.dequeueOutputBuffer(bufferInfo, 10000) ?: continue
                
                when {
                    outputBufferId == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        // 发送 SPS/PPS 配置数据
                        val format = mediaCodec?.outputFormat
                        val csd0 = format?.getByteBuffer("csd-0") // SPS
                        val csd1 = format?.getByteBuffer("csd-1") // PPS
                        
                        csd0?.let { sendData(it, outputStream) }
                        csd1?.let { sendData(it, outputStream) }
                        
                        Log.d(TAG, "Sent codec config data")
                    }
                    
                    outputBufferId >= 0 -> {
                        val outputBuffer = mediaCodec?.getOutputBuffer(outputBufferId)
                        
                        if (outputBuffer != null && bufferInfo.size > 0) {
                            sendData(outputBuffer, outputStream, bufferInfo)
                        }
                        
                        mediaCodec?.releaseOutputBuffer(outputBufferId, false)
                    }
                }
                
            } catch (e: Exception) {
                Log.e(TAG, "Encoding error", e)
                break
            }
        }
    }

    private fun sendData(buffer: ByteBuffer, outputStream: java.io.OutputStream, bufferInfo: MediaCodec.BufferInfo? = null) {
        try {
            val size = bufferInfo?.size ?: buffer.remaining()
            
            // 发送数据包头：[size(4字节)][flags(4字节)][timestamp(8字节)]
            val header = ByteBuffer.allocate(16)
            header.putInt(size)
            header.putInt(bufferInfo?.flags ?: 0)
            header.putLong(bufferInfo?.presentationTimeUs ?: 0)
            outputStream.write(header.array())
            
            // 发送视频数据
            val data = ByteArray(size)
            buffer.position(bufferInfo?.offset ?: 0)
            buffer.get(data, 0, size)
            outputStream.write(data)
            outputStream.flush()
            
        } catch (e: Exception) {
            Log.e(TAG, "Send data error", e)
            throw e
        }
    }

    fun stop() {
        isEncoding = false
        virtualDisplay?.release()
        mediaCodec?.stop()
        mediaCodec?.release()
        scope.cancel()
        Log.d(TAG, "Encoder stopped")
    }
}
