package com.dsharnessmobile.shell

import android.content.res.ColorStateList
import android.graphics.drawable.ClipDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.animation.PathInterpolator

/** Shared drawables, motion, and press feedback for the native shell UI. */
internal object DsUi {
  val ease = PathInterpolator(0.32f, 0.72f, 0f, 1f)

  fun roundRect(
    color: Int,
    radius: Float,
    strokeColor: Int? = null,
    strokePx: Int = 1,
  ): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius
    if (strokeColor != null) setStroke(strokePx, strokeColor)
  }

  fun oval(color: Int): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(color)
  }

  fun ripple(fill: GradientDrawable, rippleColor: Int): RippleDrawable {
    val mask = GradientDrawable().apply {
      setColor(0xFFFFFFFF.toInt())
      cornerRadius = fill.cornerRadius
    }
    return RippleDrawable(ColorStateList.valueOf(rippleColor), fill, mask)
  }

  fun progressLayer(trackColor: Int, fillColor: Int, radius: Float): LayerDrawable {
    val track = GradientDrawable().apply {
      setColor(trackColor)
      cornerRadius = radius
    }
    val fill = GradientDrawable().apply {
      setColor(fillColor)
      cornerRadius = radius
    }
    val clip = ClipDrawable(fill, Gravity.START, ClipDrawable.HORIZONTAL)
    return LayerDrawable(arrayOf(track, clip)).apply {
      setId(0, android.R.id.background)
      setId(1, android.R.id.progress)
    }
  }

  fun bindPressScale(view: View, scale: Float = 0.975f) {
    view.setOnTouchListener { v, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN ->
          v.animate().scaleX(scale).scaleY(scale).setDuration(90).setInterpolator(ease).start()
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
          v.animate().scaleX(1f).scaleY(1f).setDuration(160).setInterpolator(ease).start()
      }
      false
    }
  }
}
