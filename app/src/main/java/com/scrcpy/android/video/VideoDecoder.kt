package com.scrcpy.android.video

import android.media.MediaCodec
import android.media.MediaFormat
import android.view.Surface
import com.scrcpy.android.network.SocketClient
import kotlinx.coroutines.*
import java.nio.ByteBuffer

class VideoDecoder(
    private val socketClient: SocketClient,
    private val surface: Surface
) {
    
    private var mediaCodec: MediaCodec? = null
    private var isDecoding = false
    private val scope = CoroutineScope(Dispatchers.Default + Job())

    companion object {
        private const val WIDTH = 720
        private const val HEIGHT = 1280
    }

    fun start() {
        scope.launch {
            try {
                setupDecoder()
                startDecoding()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun setupDecoder() {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT)
        
        mediaCodec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        mediaCodec?.configure(format, surface, null, 0)
        mediaCodec?.start()
    }

    private fun startDecoding() {
        isDecoding = true

        while (isDecoding) {
            try {
                // 读取数据大小
                val sizeBuffer = ByteArray(4)
                val sizeRead = socketClient.readData(sizeBuffer)
                if (sizeRead != 4) break
                
                val dataSize = ByteBuffer.wrap(sizeBuffer).int
                if (dataSize <= 0) continue
                
                // 读取视频数据
                val dataBuffer = ByteArray(dataSize)
                var totalRead = 0
                while (totalRead < dataSize) {
                    val read = socketClient.readData(dataBuffer.copyOfRange(totalRead, dataSize))
                    if (read < 0) break
                    totalRead += read
                }
                
                if (totalRead != dataSize) break
                
                // 解码
                val inputBufferId = mediaCodec?.dequeueInputBuffer(10000) ?: continue
                if (inputBufferId >= 0) {
                    val inputBuffer = mediaCodec?.getInputBuffer(inputBufferId)
                    inputBuffer?.clear()
                    inputBuffer?.put(dataBuffer)
                    mediaCodec?.queueInputBuffer(inputBufferId, 0, dataSize, System.currentTimeMillis(), 0)
                }
                
                val bufferInfo = MediaCodec.BufferInfo()
                val outputBufferId = mediaCodec?.dequeueOutputBuffer(bufferInfo, 10000) ?: continue
                if (outputBufferId >= 0) {
                    mediaCodec?.releaseOutputBuffer(outputBufferId, true)
                }
                
            } catch (e: Exception) {
                e.printStackTrace()
                break
            }
        }
    }

    fun stop() {
        isDecoding = false
        mediaCodec?.stop()
        mediaCodec?.release()
        scope.cancel()
    }
}
